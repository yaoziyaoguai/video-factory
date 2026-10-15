import hashlib
import io
import json
import math
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
import wave
from array import array
from pathlib import Path
from unittest.mock import patch

from video_factory.continuous_voiceover import NarrationGroupDoesNotFitError, assemble_narration_track
from video_factory.narration_plan import build_narration_plan, SAMPLE_RATE
from video_factory.group_voiceover import synthesize_minimax_groups
from video_factory.voiceover import _MiniMaxTerminalError
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

    def test_active_prepared_groups_cannot_be_taken_by_a_different_operation(self):
        plan = build_narration_plan([{"position": 1, "duration": 3, "narration": "保留原请求的执行权。"}],
                                    script_sha256="a" * 64, visual_sha256="b" * 64)
        prepared, release = threading.Event(), threading.Event()
        original_write = group_voiceover_module._write_json_durably
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "voice"

            def write_and_pause(file, ledger):
                original_write(file, ledger)
                if ledger["operationId"] == "active" and all(item["state"] == "prepared" for item in ledger["items"]):
                    prepared.set()
                    if not release.wait(2):
                        raise AssertionError("prepared operation was not released")

            def send(request, audio, metadata_path=None, response_binding=None):
                tone(audio, 0.4)
                metadata_path.write_text(json.dumps({"request": response_binding,
                    "audio_sha256": hashlib.sha256(audio.read_bytes()).hexdigest(), "audio_size_bytes": audio.stat().st_size}))

            def run(operation):
                return synthesize_minimax_groups(plan, root / operation, operation_id=operation,
                    voice="female-chengshu", rate=190, pause_scale=1, model_id="speech-2.8-turbo", authorization_cny=1)

            with patch("video_factory.group_voiceover._write_json_durably", side_effect=write_and_pause), \
                    patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=send) as provider, \
                    patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}), ThreadPoolExecutor(max_workers=2) as executor:
                first = executor.submit(run, "active")
                try:
                    self.assertTrue(prepared.wait(2))
                    with self.assertRaisesRegex(RuntimeError, "unsettled"):
                        group_voiceover_module.forecast_minimax_groups(plan, root, voice="female-chengshu",
                            rate=190, pause_scale=1, model_id="speech-2.8-turbo")
                    provider.assert_not_called()
                    second = executor.submit(run, "other")
                finally:
                    release.set()
                first.result(timeout=2)
                try:
                    second.result(timeout=2)
                except RuntimeError as error:
                    self.assertIn("unsettled", str(error))
                self.assertEqual(provider.call_count, 1)
                # 原执行落稳后，新操作只能复用；报价读取不改原账本。
                original = root / ".voice-operations" / (hashlib.sha256(b"active").hexdigest() + ".json")
                before = original.read_bytes()
                quote = group_voiceover_module.forecast_minimax_groups(plan, root, voice="female-chengshu",
                    rate=190, pause_scale=1, model_id="speech-2.8-turbo")
                self.assertTrue(quote["items"][0]["reused"])
                run("after-settled")
                self.assertEqual(provider.call_count, 1)
                self.assertEqual(original.read_bytes(), before)

    def test_same_group_operation_has_one_execution_owner(self):
        plan = build_narration_plan([{"position": 1, "duration": 3, "narration": "相同编号只发送一次。"}],
                                    script_sha256="a" * 64, visual_sha256="b" * 64)
        entered, release, competing = threading.Event(), threading.Event(), threading.Event()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "voice"

            def send(request, audio, metadata_path=None, response_binding=None):
                entered.set()
                if not release.wait(2):
                    raise AssertionError("provider boundary was not released")
                tone(audio, 0.4)
                metadata_path.write_text(json.dumps({"request": response_binding,
                    "audio_sha256": hashlib.sha256(audio.read_bytes()).hexdigest(), "audio_size_bytes": audio.stat().st_size}))

            def run(contender=False):
                if contender:
                    competing.set()
                return synthesize_minimax_groups(plan, root / "same", operation_id="same", voice="female-chengshu",
                    rate=190, pause_scale=1, model_id="speech-2.8-turbo", authorization_cny=1)

            with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=send) as provider, \
                    patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}), ThreadPoolExecutor(max_workers=2) as executor:
                first = executor.submit(run)
                try:
                    self.assertTrue(entered.wait(2))
                    second = executor.submit(run, True)
                    self.assertTrue(competing.wait(2))
                finally:
                    release.set()
                first.result(timeout=2)
                second.result(timeout=2)
                self.assertEqual(provider.call_count, 1)

    def test_explicit_rejection_then_legal_new_operation_retries_only_failed_groups(self):
        # R4-A（连续旁白）：三组中第 1 组成功、第 2 组明确拒收、第 3 组未发；
        # 合法新重试只生成 2/3，第 1 组按原字节/来源复用、费用不重复，旧 ID 不重发。
        scenes = [{"position": 1, "duration": 3, "narration": "第一组先说。"},
                  {"position": 2, "duration": 1, "narration": "……"},
                  {"position": 3, "duration": 3, "narration": "第二组被拒。"},
                  {"position": 4, "duration": 1, "narration": "……"},
                  {"position": 5, "duration": 3, "narration": "第三组未发。"}]
        plan = build_narration_plan(scenes, script_sha256="a" * 64, visual_sha256="b" * 64)
        self.assertEqual(len(plan["groups"]), 3)
        calls = []
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "voice"
            def send(request, audio, metadata_path=None, response_binding=None):
                calls.append(json.loads(request.data)["text"].rstrip("\n"))
                if len(calls) == 2:
                    raise _MiniMaxTerminalError("definitively rejected")
                tone(audio, 0.4)
                metadata_path.write_text(json.dumps({"request": response_binding,
                    "audio_sha256": hashlib.sha256(audio.read_bytes()).hexdigest(),
                    "audio_size_bytes": audio.stat().st_size, "extra_info": {"usage_characters": 10}}))
            def run(operation):
                return synthesize_minimax_groups(plan, root / operation, operation_id=operation,
                    voice="female-chengshu", rate=190, pause_scale=1, model_id="speech-2.8-turbo",
                    authorization_cny=1)
            with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=send), \
                    patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}):
                with self.assertRaises(_MiniMaxTerminalError):
                    run("original")
                original_ledger_path = root / ".voice-operations" / (hashlib.sha256(b"original").hexdigest() + ".json")
                old_ledger = json.loads(original_ledger_path.read_text())
                self.assertEqual([item["state"] for item in old_ledger["items"]],
                                 ["materialized", "terminal_failed", "prepared"])
                self.assertEqual(old_ledger["terminalEvidence"]["source"], "explicit_rejection")
                self.assertEqual(old_ledger["terminalEvidence"]["itemRequestIds"],
                                 [old_ledger["items"][1]["itemRequestId"]])
                first_group_bytes = Path(old_ledger["items"][0]["localPath"]).read_bytes()
                old_paid_cost = old_ledger["actualCostCny"]
                self.assertGreater(old_paid_cost, 0)
                # 旧操作 ID 不能被重新激活。
                with self.assertRaisesRegex(RuntimeError, "unsettled or failed"):
                    run("original")
                retried = run("user-confirmed-retry")
                # 原操作发了 2 次（成功 1 + 拒收 1）；新操作只补发第 2、3 组。
                self.assertEqual(calls, [plan["groups"][0]["text"], plan["groups"][1]["text"],
                                         plan["groups"][1]["text"], plan["groups"][2]["text"]])
                new_ledger = json.loads(Path(retried["ledgerPath"]).read_text())
                self.assertEqual(new_ledger["items"][0].get("reusedFromOperationId"), "original")
                self.assertEqual(new_ledger["items"][0]["actualCostCny"], 0)
                self.assertEqual(Path(new_ledger["items"][0]["localPath"]).read_bytes(), first_group_bytes)
                self.assertNotEqual(new_ledger["items"][1]["itemRequestId"], old_ledger["items"][1]["itemRequestId"])
                # 旧操作的费用记录保持原样，不因复用被清零。
                self.assertEqual(json.loads(original_ledger_path.read_text())["actualCostCny"], old_paid_cost)

    def test_unknown_or_terminal_unknown_mixed_groups_keep_blocking_new_operations(self):
        # R4-B：第 3 组 unknown（纯超时路径）时，原操作、新操作、换音色、重新报价都
        # 不能诱发新 create，占用不清零。混合形态（terminal＋unknown 并存）无法由
        # 单次执行自然产生（terminal 抛出即停止后续组），用构造账本直接核验同一保守口径。
        scenes = [{"position": 1, "duration": 3, "narration": "第一组先说。"},
                  {"position": 2, "duration": 1, "narration": "……"},
                  {"position": 3, "duration": 3, "narration": "第二组跟上。"},
                  {"position": 4, "duration": 1, "narration": "……"},
                  {"position": 5, "duration": 3, "narration": "第三组不定。"}]
        plan = build_narration_plan(scenes, script_sha256="a" * 64, visual_sha256="b" * 64)
        self.assertEqual(len(plan["groups"]), 3)
        calls = []
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "voice"
            def send(request, audio, metadata_path=None, response_binding=None):
                calls.append(json.loads(request.data))
                if len(calls) == 3:
                    raise TimeoutError("accepted-without-response")
                tone(audio, 0.4)
                metadata_path.write_text(json.dumps({"request": response_binding,
                    "audio_sha256": hashlib.sha256(audio.read_bytes()).hexdigest(),
                    "audio_size_bytes": audio.stat().st_size}))
            def run(operation, voice="female-chengshu"):
                return synthesize_minimax_groups(plan, root / operation, operation_id=operation,
                    voice=voice, rate=190, pause_scale=1, model_id="speech-2.8-turbo", authorization_cny=1)
            with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=send), \
                    patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}):
                with self.assertRaises(TimeoutError):
                    run("original")
                ledger_path = root / ".voice-operations" / (hashlib.sha256(b"original").hexdigest() + ".json")
                self.assertEqual([item["state"] for item in json.loads(ledger_path.read_text())["items"]],
                                 ["materialized", "materialized", "unknown"])
                for operation in ("original", "different-id"):
                    with self.assertRaisesRegex(RuntimeError, "unsettled"):
                        run(operation)
                # 换音色改变 synthesisKey，仍不能绕过 unknown 的保守占用。
                with self.assertRaisesRegex(RuntimeError, "unsettled"):
                    run("voice-changed", voice="female-tianmei")
                with self.assertRaisesRegex(RuntimeError, "unsettled"):
                    group_voiceover_module.forecast_minimax_groups(plan, root,
                        voice="female-tianmei", rate=190, pause_scale=1, model_id="speech-2.8-turbo")
                self.assertEqual(len(calls), 3, "排空阻塞期间不得产生新请求")
                self.assertEqual([item["state"] for item in json.loads(ledger_path.read_text())["items"]],
                                 ["materialized", "materialized", "unknown"], "占用状态不能被读取操作清零")
        # 混合形态：第 2 组明确拒收＋第 3 组 unknown——即便存在终结依据，
        # 只要还有任何未核清组（unknown），新操作依旧被阻止。
        fresh = group_voiceover_module._group_items(
            plan, operation_id="mixed-op", voice="female-chengshu", rate=190, pause_scale=1,
            model_id="speech-2.8-turbo", provider_id="minimax-tts-v1")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "voice"
            raw, materialized = self._materialized_item(root, "mixed-op", plan["groups"][0], fresh[0]["itemRequestId"], fresh[0]["synthesisKey"])
            materialized["synthesisKey"] = fresh[0]["synthesisKey"]
            materialized["quote"] = fresh[0]["quote"]
            terminal = {**fresh[1], "state": "terminal_failed",
                        "stateHistory": ["prepared", "terminal_failed"]}
            unknown = {**fresh[2], "state": "unknown", "stateHistory": ["prepared", "unknown"]}
            self._crafted_ledger(root, "mixed-op", [materialized, terminal, unknown], terminal_evidence={
                "source": "explicit_rejection", "recordedAt": "2026-10-15T00:00:00Z",
                "itemRequestIds": [fresh[1]["itemRequestId"]]})
            with patch("video_factory.group_voiceover._execute_minimax_audio_request") as provider:
                with self.assertRaisesRegex(RuntimeError, "unsettled"):
                    synthesize_minimax_groups(plan, root / "new-op", operation_id="new-op",
                        voice="female-chengshu", rate=190, pause_scale=1, model_id="speech-2.8-turbo",
                        authorization_cny=1)
                provider.assert_not_called()

    def _crafted_ledger(self, root, operation, items, terminal_evidence=None):
        ledger = {"version": group_voiceover_module.VERSION, "operationId": operation,
                  "providerId": "minimax-tts-v1", "modelId": "speech-2.8-turbo",
                  "estimatedCostCny": 0, "items": items, "completed": False,
                  "actualCostCny": 0, "actualCostSource": "configured_rate"}
        if terminal_evidence is not None:
            ledger["terminalEvidence"] = terminal_evidence
        directory = root / ".voice-operations"
        directory.mkdir(parents=True, exist_ok=True)
        ledger_path = directory / (hashlib.sha256(operation.encode()).hexdigest() + ".json")
        ledger_path.write_text(json.dumps(ledger))
        return ledger_path

    def _materialized_item(self, root, operation, group, item_id, synthesis_key):
        raw = root / operation / f"{item_id}.mp3"
        raw.parent.mkdir(parents=True, exist_ok=True)
        tone(raw, 0.4)
        content = raw.read_bytes()
        metadata = raw.with_suffix(".response.json")
        metadata.write_text(json.dumps({"request": {"itemRequestId": item_id, "synthesisKey": synthesis_key},
            "audio_sha256": hashlib.sha256(content).hexdigest(), "audio_size_bytes": len(content)}))
        return raw, {"groupId": group["id"], "itemRequestId": item_id,
                     "synthesisKey": synthesis_key, "quote": None, "state": "materialized",
                     "stateHistory": ["prepared", "unknown", "materialized"],
                     "localPath": str(raw), "sha256": hashlib.sha256(content).hexdigest(),
                     "metadataPath": str(metadata), "metadataSha256": hashlib.sha256(metadata.read_bytes()).hexdigest(),
                     "sizeBytes": len(content), "actualCostCny": 0.06}

    def test_old_ledger_without_terminal_field_is_judged_by_original_facts(self):
        # R4-D：旧 v3 没有终结字段时，只能据原事实（历史里的 terminal_failed）判断，
        # 不能按时间、prepared 或 completed=false 推断解禁。
        scenes = [{"position": 1, "duration": 3, "narration": "第一组先说。"},
                  {"position": 2, "duration": 1, "narration": "……"},
                  {"position": 3, "duration": 3, "narration": "第二组跟上。"}]
        plan = build_narration_plan(scenes, script_sha256="a" * 64, visual_sha256="b" * 64)
        self.assertEqual(len(plan["groups"]), 2)
        fresh = group_voiceover_module._group_items(
            plan, operation_id="old-op", voice="female-chengshu", rate=190, pause_scale=1,
            model_id="speech-2.8-turbo", provider_id="minimax-tts-v1")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "voice"
            raw, materialized = self._materialized_item(root, "old-op", plan["groups"][0], fresh[0]["itemRequestId"], fresh[0]["synthesisKey"])
            materialized["synthesisKey"] = fresh[0]["synthesisKey"]
            materialized["quote"] = fresh[0]["quote"]
            # 旧版结清代码留下的形态：状态被重置为 prepared，但历史仍保留 terminal_failed 原事实。
            reset = {**fresh[1], "state": "prepared", "stateHistory": ["prepared", "unknown", "terminal_failed", "prepared"]}
            self._crafted_ledger(root, "old-op", [materialized, reset])
            calls = []
            def send(request, audio, metadata_path=None, response_binding=None):
                calls.append(json.loads(request.data))
                tone(audio, 0.4)
                metadata_path.write_text(json.dumps({"request": response_binding,
                    "audio_sha256": hashlib.sha256(audio.read_bytes()).hexdigest(),
                    "audio_size_bytes": audio.stat().st_size}))
            with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=send), \
                    patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}):
                retried = synthesize_minimax_groups(plan, root / "new-op", operation_id="new-op",
                    voice="female-chengshu", rate=190, pause_scale=1, model_id="speech-2.8-turbo",
                    authorization_cny=1)
                self.assertEqual(len(calls), 1, "第 1 组复用，只补发第 2 组")
                self.assertEqual(retried["rawAudio"][plan["groups"][0]["id"]], raw.resolve())
            # 对照：没有任何终结原事实的 prepared 旧账本仍然阻止新操作。
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary) / "voice"
                raw2, materialized2 = self._materialized_item(root, "plain-op", plan["groups"][0], fresh[0]["itemRequestId"], fresh[0]["synthesisKey"])
                materialized2["synthesisKey"] = fresh[0]["synthesisKey"]
                materialized2["quote"] = fresh[0]["quote"]
                plain = {**fresh[1], "state": "prepared", "stateHistory": ["prepared"]}
                self._crafted_ledger(root, "plain-op", [materialized2, plain])
                with patch("video_factory.group_voiceover._execute_minimax_audio_request") as provider:
                    with self.assertRaisesRegex(RuntimeError, "unsettled"):
                        synthesize_minimax_groups(plan, root / "new-op", operation_id="new-op",
                            voice="female-chengshu", rate=190, pause_scale=1, model_id="speech-2.8-turbo",
                            authorization_cny=1)
                    provider.assert_not_called()

    def test_terminal_label_without_completed_reconciliation_cannot_release_prepared_groups(self):
        plan = build_narration_plan([{"position": 1, "duration": 3, "narration": "尚未发送的原组。"}],
                                    script_sha256="a" * 64, visual_sha256="b" * 64)
        for evidence in ({"source": "explicit_rejection"}, {"source": "reconciliation"},
                         {"reconciliation": {"reconciliationId": "missing"}}):
            with self.subTest(evidence=evidence), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary) / "runs" / "new-run" / "nodes" / "voice"
                fresh = group_voiceover_module._group_items(plan, operation_id="original",
                    voice="female-chengshu", rate=190, pause_scale=1, model_id="speech-2.8-turbo", provider_id="minimax-tts-v1")
                ledger_path = self._crafted_ledger(root, "original", fresh, terminal_evidence=evidence)
                before = ledger_path.read_bytes()
                with patch("video_factory.group_voiceover._execute_minimax_audio_request") as provider:
                    with self.assertRaisesRegex(RuntimeError, "unsettled|reconciliation"):
                        group_voiceover_module.forecast_minimax_groups(plan, root, voice="female-chengshu",
                            rate=190, pause_scale=1, model_id="speech-2.8-turbo")
                    with self.assertRaisesRegex(RuntimeError, "unsettled|reconciliation"):
                        synthesize_minimax_groups(plan, root / "new-op", operation_id="new-op", voice="female-chengshu",
                            rate=190, pause_scale=1, model_id="speech-2.8-turbo", authorization_cny=1)
                    provider.assert_not_called()
                self.assertEqual(ledger_path.read_bytes(), before)

    def test_materialized_group_requires_original_response_bytes_and_binding(self):
        plan = build_narration_plan([{"position": 1, "duration": 3, "narration": "保留原声音与原响应。"}],
                                    script_sha256="a" * 64, visual_sha256="b" * 64)
        for failure in ("missing", "binding", "bytes"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary) / "voice"
                def send(request, audio, metadata_path=None, response_binding=None):
                    tone(audio, 0.4)
                    metadata_path.write_text(json.dumps({"request": response_binding,
                        "audio_sha256": hashlib.sha256(audio.read_bytes()).hexdigest(),
                        "audio_size_bytes": audio.stat().st_size}))
                def run(operation):
                    return synthesize_minimax_groups(plan, root / operation, operation_id=operation,
                        voice="female-chengshu", rate=190, pause_scale=1, model_id="speech-2.8-turbo", authorization_cny=1)
                with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=send) as provider, \
                        patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}):
                    result = run("original")
                    ledger_path = Path(result["ledgerPath"])
                    original = ledger_path.read_bytes()
                    item = json.loads(original)["items"][0]
                    metadata = Path(item["metadataPath"])
                    if failure == "missing":
                        metadata.unlink()
                    elif failure == "binding":
                        value = json.loads(metadata.read_text())
                        value["request"]["itemRequestId"] = "another-request"
                        metadata.write_text(json.dumps(value))
                    else:
                        metadata.write_text(metadata.read_text() + "\n")
                    for operation in ("original", "new-operation"):
                        with self.assertRaisesRegex(RuntimeError, "response"):
                            run(operation)
                    with self.assertRaisesRegex(RuntimeError, "response"):
                        group_voiceover_module.forecast_minimax_groups(plan, root, voice="female-chengshu",
                            rate=190, pause_scale=1, model_id="speech-2.8-turbo")
                    self.assertEqual(provider.call_count, 1)
                    self.assertEqual(ledger_path.read_bytes(), original)

    def test_reconciliation_terminal_evidence_releases_never_sent_groups(self):
        # worker 读取边界的合成夹具；真实宿主结清和进程重启另由 e2e.voice-r4 覆盖。
        scenes = [{"position": 1, "duration": 3, "narration": "第一组先说。"},
                  {"position": 2, "duration": 1, "narration": "……"},
                  {"position": 3, "duration": 3, "narration": "第二组跟上。"}]
        plan = build_narration_plan(scenes, script_sha256="a" * 64, visual_sha256="b" * 64)
        self.assertEqual(len(plan["groups"]), 2)
        fresh = group_voiceover_module._group_items(
            plan, operation_id="settled-op", voice="female-chengshu", rate=190, pause_scale=1,
            model_id="speech-2.8-turbo", provider_id="minimax-tts-v1")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "runs" / "new-run" / "nodes" / "voice"
            raw, materialized = self._materialized_item(root, "settled-op", plan["groups"][0], fresh[0]["itemRequestId"], fresh[0]["synthesisKey"])
            materialized["synthesisKey"] = fresh[0]["synthesisKey"]
            materialized["quote"] = fresh[0]["quote"]
            evidence = {"source": "reconciliation", "recordedAt": "2026-10-15T00:00:00Z",
                        "itemRequestIds": [fresh[1]["itemRequestId"]],
                        "reconciliation": {"reconciliationId": "reconcile-1", "settledAt": "2026-10-15T00:00:00Z",
                                           "settledItemRequestIds": [fresh[1]["itemRequestId"]]}}
            fresh[1]["notChargedSettlement"] = {"reconciliationId": "reconcile-1", "settledAt": evidence["recordedAt"]}
            self._crafted_ledger(root, "settled-op", [materialized, fresh[1]], terminal_evidence=evidence)
            run_root = root.parent.parent
            records = run_root / ".paid-reconciliations"
            records.mkdir()
            record_path = records / (hashlib.sha256(b"reconcile-1").hexdigest() + ".json")
            record = {"version": "video-factory/paid-reconciliation-v1", "reconciliationId": "reconcile-1",
                      "runId": "new-run", "nodeId": "voice", "operationId": "settled-op",
                      "outcome": "confirmed_not_charged", "settledItemRequestIds": [fresh[1]["itemRequestId"]],
                      "status": "completed", "expectedRunRevision": 2, "resultingRunRevision": 3}
            (run_root / "run.json").write_text(json.dumps({"id": "new-run", "revision": 3,
                "executionReceipts": [{"nodeId": "voice", "requestId": "settled-op"}]}))
            with patch("video_factory.group_voiceover._execute_minimax_audio_request") as provider:
                for field, value in (("status", "in_progress"), ("operationId", "other"), ("runId", "other"),
                                     ("settledItemRequestIds", []), ("resultingRunRevision", 4)):
                    with self.subTest(field=field):
                        record_path.write_text(json.dumps({**record, field: value}))
                        with self.assertRaisesRegex(RuntimeError, "reconciliation"):
                            group_voiceover_module.forecast_minimax_groups(plan, root, voice="female-chengshu",
                                rate=190, pause_scale=1, model_id="speech-2.8-turbo")
                provider.assert_not_called()
            record_path.write_text(json.dumps(record))
            calls = []
            def send(request, audio, metadata_path=None, response_binding=None):
                calls.append(json.loads(request.data))
                tone(audio, 0.4)
                metadata_path.write_text(json.dumps({"request": response_binding,
                    "audio_sha256": hashlib.sha256(audio.read_bytes()).hexdigest(),
                    "audio_size_bytes": audio.stat().st_size}))
            with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=send), \
                    patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}):
                retried = synthesize_minimax_groups(plan, root / "new-op", operation_id="new-op",
                    voice="female-chengshu", rate=190, pause_scale=1, model_id="speech-2.8-turbo",
                    authorization_cny=1)
                self.assertEqual(len(calls), 1)
                self.assertEqual(retried["rawAudio"][plan["groups"][0]["id"]], raw.resolve())


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
