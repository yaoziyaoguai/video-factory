import hashlib
import io
import json
import math
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from video_factory.narration_subtitles import (
    SAMPLE_RATE,
    build_group_subtitles,
    capture_subtitle_evidence,
    cues_to_ass,
    cues_to_vtt,
    map_cues_to_narration_timeline,
    parse_provider_subtitle_cues,
    recover_subtitles,
)

INTERNAL_ADAPTER = "video-factory/internal-sample-cues-v1"


class NarrationSubtitlesTest(unittest.TestCase):
    def test_keeps_raw_subtitle_evidence_once_without_guessing_cue_fields_or_rebuying_audio(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            metadata = root / "response.json"
            metadata.write_text(json.dumps({"request": {"itemRequestId": "request-one", "synthesisKey": "a" * 64},
                "audio_sha256": "b" * 64, "subtitle_file": "https://public.example/subtitles.json?signature=private"}))
            ledger = root / "operation.json"
            ledger.write_text(json.dumps({"version": "video-factory/voice-operation-v3", "items": [
                {"groupId": "narration-1", "itemRequestId": "request-one", "synthesisKey": "a" * 64,
                 "sha256": "b" * 64, "metadataPath": str(metadata),
                 "metadataSha256": hashlib.sha256(metadata.read_bytes()).hexdigest()}]}))
            payload = b'{"unverified_vendor_shape": []}'
            with patch("video_factory.narration_subtitles.open_asset_request", return_value=io.BytesIO(payload)) as download:
                result = capture_subtitle_evidence(ledger, root)
                restored = capture_subtitle_evidence(ledger, root)
                self.assertEqual(download.call_count, 1)
            self.assertEqual(result, restored)
            self.assertEqual(result["status"], "unavailable")
            self.assertEqual(result["cues"], [])
            self.assertEqual(result["evidence"][0]["status"], "captured_unverified")
            self.assertEqual(Path(result["evidence"][0]["path"]).read_bytes(), payload)
            self.assertNotIn("signature", json.dumps(result))
            # 不同音频不能认领以前的字幕缓存。
            changed = json.loads(ledger.read_text())
            changed["items"][0]["sha256"] = "c" * 64
            ledger.write_text(json.dumps(changed))
            with patch("video_factory.narration_subtitles.open_asset_request") as download:
                rejected = capture_subtitle_evidence(ledger, root)
                self.assertEqual(rejected["status"], "unavailable")
                download.assert_not_called()

    def test_failed_subtitle_download_does_not_retry_or_hide_available_audio(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            metadata = root / "response.json"
            metadata.write_text(json.dumps({"request": {"itemRequestId": "r", "synthesisKey": "a" * 64},
                "audio_sha256": "b" * 64, "subtitle_file": "https://public.example/expired.json"}))
            ledger = root / "operation.json"
            ledger.write_text(json.dumps({"version": "video-factory/voice-operation-v3", "items": [
                {"groupId": "narration-1", "itemRequestId": "r", "synthesisKey": "a" * 64,
                 "sha256": "b" * 64, "metadataPath": str(metadata),
                 "metadataSha256": hashlib.sha256(metadata.read_bytes()).hexdigest()}]}))
            with patch("video_factory.narration_subtitles.open_asset_request", side_effect=TimeoutError("private")) as download:
                result = capture_subtitle_evidence(ledger, root)
                capture_subtitle_evidence(ledger, root)
                self.assertEqual(download.call_count, 1)
            self.assertEqual(result["status"], "unavailable")
            self.assertNotIn("private", json.dumps(result))


class ProviderCueParsingTest(unittest.TestCase):
    """内部规范 cue 合同（消费链验证）。服务商协议仍 blocked_provider_schema：未实测不猜字段。"""

    def test_unknown_adapter_stays_unavailable_without_guessing_units(self):
        result = parse_provider_subtitle_cues(b'{"anything": true}', adapter_version="minimax-subtitles-unknown")
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["reason"], "provider_schema_unverified")
        self.assertEqual(result["cues"], [])

    def test_verified_minimax_sentence_adapter_parses_real_sample_shape(self):
        # 2026-09-27 真实采样核实：顶层 cue 数组，time_begin/time_end 为毫秒、音频起点原点。
        sample = json.dumps([
            {"text": "在城市醒来，先给自己三秒。", "pronounce_text": "x",
             "time_begin": 0.0, "time_end": 2918.5941043083903,
             "text_begin": 0, "text_end": 13,
             "pronounce_text_begin": 0, "pronounce_text_end": 13},
        ], ensure_ascii=False).encode()
        parsed = parse_provider_subtitle_cues(sample, adapter_version="minimax-subtitles-v1")
        self.assertEqual(parsed["status"], "verified")
        self.assertAlmostEqual(parsed["cues"][0]["start"], 0.0)
        self.assertAlmostEqual(parsed["cues"][0]["end"], 2.9185941043083903)
        bad_documents = [
            {"not": "a list"},
            [{"text": "缺时间"}],
            [{"time_begin": 100, "time_end": 50, "text": "倒置"}],
            [{"time_begin": -1, "time_end": 100, "text": "负数"}],
            [{"time_begin": 0, "time_end": 100, "text": ""}],
        ]
        for document in bad_documents:
            parsed = parse_provider_subtitle_cues(json.dumps(document, ensure_ascii=False).encode(), adapter_version="minimax-subtitles-v1")
            self.assertEqual(parsed["status"], "unavailable")
            self.assertEqual(parsed["cues"], [])

    def test_internal_sample_adapter_parses_and_rejects_malformed_documents(self):
        good = json.dumps({"version": INTERNAL_ADAPTER, "cues": [
            {"start": 0.0, "end": 1.25, "text": "先停一下。"},
            {"start": 1.25, "end": 2.0, "text": "再看一次。"},
        ]}).encode()
        parsed = parse_provider_subtitle_cues(good, adapter_version=INTERNAL_ADAPTER)
        self.assertEqual(parsed["status"], "verified")
        self.assertEqual([cue["text"] for cue in parsed["cues"]], ["先停一下。", "再看一次。"])
        bad_documents = [
            {"version": "other", "cues": []},
            {"version": INTERNAL_ADAPTER, "cues": [{"start": 1, "end": 0.5, "text": "倒置"}]},
            {"version": INTERNAL_ADAPTER, "cues": [{"start": -1, "end": 1, "text": "负数"}]},
            {"version": INTERNAL_ADAPTER, "cues": [{"start": 0, "end": 1, "text": ""}]},
            {"version": INTERNAL_ADAPTER, "cues": [{"start": 0, "end": 2, "text": "a"}, {"start": 1, "end": 3, "text": "b"}]},
        ]
        for document in bad_documents:
            parsed = parse_provider_subtitle_cues(json.dumps(document, ensure_ascii=False).encode(), adapter_version=INTERNAL_ADAPTER)
            self.assertEqual(parsed["status"], "unavailable")
            self.assertEqual(parsed["cues"], [])
        parsed = parse_provider_subtitle_cues(b"not json", adapter_version=INTERNAL_ADAPTER)
        self.assertEqual(parsed["status"], "unavailable")
        self.assertEqual(parsed["cues"], [])

    def test_maps_cues_with_actual_group_start_including_end_anchor_and_cross_scene_cues(self):
        # assemble 语义：anchor=end、offsetFrames 非零时 startSample 由真实放置决定；
        # 组跨镜不改变 sample 坐标，cue 也不按镜拆分。
        # 2 秒组尾锚在 300–360 帧窗口（60 帧 = 2 秒），startSample = 360*1470 - 88200 = 441000。
        samples = SAMPLE_RATE * 2
        group = {
            "id": "narration-1", "startSample": 441_000, "sourceAudioSamples": samples,
            "window": {"startFrame": 300, "endFrame": 360},
        }
        mapped = map_cues_to_narration_timeline([
            {"start": 0.0, "end": 1.0, "text": "跨镜的一句。"},
            {"start": 1.5, "end": 2.0, "text": "收尾。"},
        ], group)
        self.assertEqual(mapped[0]["startSample"], 441_000)
        self.assertEqual(mapped[0]["groupId"], "narration-1")
        self.assertEqual(mapped[0]["endSample"], 441_000 + SAMPLE_RATE)
        self.assertEqual(mapped[0]["localStartSample"], 0)
        self.assertEqual(mapped[1]["localEndSample"], math.ceil(2.0 * SAMPLE_RATE))
        self.assertEqual(mapped[1]["endSample"], 441_000 + 2 * SAMPLE_RATE)

    def test_rejects_cues_beyond_source_audio_or_confirmed_window(self):
        group = {"id": "g", "startSample": 0, "sourceAudioSamples": SAMPLE_RATE,
                 "window": {"startFrame": 0, "endFrame": 30}}
        with self.assertRaises(ValueError):
            map_cues_to_narration_timeline([{"start": 0.0, "end": 2.0, "text": "超长"}], group)
        short_window = {"id": "g", "startSample": SAMPLE_RATE, "sourceAudioSamples": SAMPLE_RATE,
                        "window": {"startFrame": 0, "endFrame": 30}}
        with self.assertRaises(ValueError):
            map_cues_to_narration_timeline([{"start": 0.0, "end": 1.0, "text": "越窗"}], short_window)

    def test_sidecar_rendering_uses_sample_clock_and_escapes_ass_text(self):
        cues = [{"startSample": 0, "endSample": SAMPLE_RATE, "text": "带 {标签} 与\n换行"}]
        vtt = cues_to_vtt(cues)
        self.assertIn("00:00:00.000 --> 00:00:01.000", vtt)
        ass = cues_to_ass(cues)
        self.assertIn("Dialogue: 0,0:00:00.00,0:00:01.00,Narration", ass)
        self.assertIn("带 \\{标签\\} 与\\N换行", ass)


class GroupSubtitlesContractTest(unittest.TestCase):
    def _prepare(self, root: Path, payload: bytes):
        metadata = root / "response.json"
        metadata.write_text(json.dumps({"request": {"itemRequestId": "request-one", "synthesisKey": "a" * 64},
            "audio_sha256": "b" * 64, "subtitle_file": "https://public.example/subtitles.json"}))
        ledger = root / "operation.json"
        ledger.write_text(json.dumps({"version": "video-factory/voice-operation-v3", "items": [
            {"groupId": "narration-1", "itemRequestId": "request-one", "synthesisKey": "a" * 64,
             "sha256": "b" * 64, "metadataPath": str(metadata),
             "metadataSha256": hashlib.sha256(metadata.read_bytes()).hexdigest()}]}))
        return ledger

    def _assembled(self):
        return {"layoutKey": "d" * 64, "groups": [{
            "id": "narration-1", "startSample": 0, "sourceAudioSamples": SAMPLE_RATE,
            "window": {"startFrame": 0, "endFrame": 45},
        }]}

    def test_builds_verified_contract_from_captured_evidence_with_internal_adapter(self):
        payload = json.dumps({"version": INTERNAL_ADAPTER, "cues": [{"start": 0.0, "end": 0.8, "text": "同步句。"}]}).encode()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            ledger = self._prepare(root, payload)
            with patch("video_factory.narration_subtitles.open_asset_request", return_value=io.BytesIO(payload)):
                contract = build_group_subtitles(ledger, root, self._assembled(),
                    narration_plan_sha256="c" * 64, adapter_version=INTERNAL_ADAPTER)
            self.assertEqual(contract["status"], "verified")
            self.assertEqual(contract["cues"][0]["startSample"], 0)
            self.assertEqual(contract["cues"][0]["endSample"], math.ceil(0.8 * SAMPLE_RATE))
            self.assertEqual(contract["layoutKey"], "d" * 64)
            self.assertEqual(contract["acceptedNarrationPlanSha256"], "c" * 64)
            # 未核实 adapter：同一证据保持不可用，cues 为空。
            with patch("video_factory.narration_subtitles.open_asset_request") as no_download:
                blocked = build_group_subtitles(ledger, root, self._assembled(),
                    narration_plan_sha256="c" * 64, adapter_version="future-provider-adapter")
                no_download.assert_not_called()
            self.assertEqual(blocked["status"], "unavailable")
            self.assertEqual(blocked["cues"], [])

    def test_recovery_reparses_cached_evidence_without_touching_unrelated_receipts(self):
        payload = json.dumps({"version": INTERNAL_ADAPTER, "cues": [{"start": 0.0, "end": 0.8, "text": "同步句。"}]}).encode()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            ledger = self._prepare(root, payload)
            with patch("video_factory.narration_subtitles.open_asset_request", return_value=io.BytesIO(payload)) as download:
                capture_subtitle_evidence(ledger, root)
                # 先制造一份 unavailable 回执（历史失败），再触发恢复。
                unavailable = root / ".subtitle-evidence"
                stale = next(unavailable.glob("*.receipt.json"))
                # captured_unverified 的缓存不能被清除；这里写入另一份 unavailable 绑定回执。
                (unavailable / "deadbeef.receipt.json").write_text(json.dumps({"binding": {"audioSha256": "f" * 64}, "status": "unavailable"}))
                contract = recover_subtitles(ledger, root, self._assembled(),
                    narration_plan_sha256="c" * 64, adapter_version=INTERNAL_ADAPTER, refetch=True,
                    refetch_reason="已恢复字幕资源连接")
                self.assertEqual(download.call_count, 1, "已缓存证据直接复用，不再下载")
            self.assertEqual(contract["status"], "verified")
            self.assertTrue((unavailable / "deadbeef.receipt.json").exists(), "当前操作不能清除其它音频的不可用回执")
            self.assertTrue(stale.exists() or any(p.name.endswith(".json") and not p.name.endswith(".receipt.json") for p in unavailable.glob("*.json")),
                "captured_unverified 的字幕缓存保留")

    def test_failed_subtitle_refetch_is_durably_limited_and_normal_resume_does_not_download(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            ledger = self._prepare(root, b"")
            with patch("video_factory.narration_subtitles.open_asset_request", side_effect=OSError("unavailable")) as download:
                capture_subtitle_evidence(ledger, root)
                self.assertEqual(download.call_count, 1)
                for _ in range(3):
                    recover_subtitles(ledger, root, self._assembled(),
                        narration_plan_sha256="c" * 64, adapter_version=INTERNAL_ADAPTER, refetch=True,
                        refetch_reason="已恢复字幕资源连接")
                self.assertEqual(download.call_count, 2, "初次下载+显式恢复各一次，持久计数不得靠删回执重置")
                capture_subtitle_evidence(ledger, root)
                self.assertEqual(download.call_count, 2)
            receipt = json.loads(next((root / ".subtitle-evidence").glob("*.receipt.json")).read_text())
            self.assertEqual(receipt["refetchCount"], 1)
            self.assertEqual(receipt["status"], "unavailable")

    def test_refetch_requires_new_evidence_and_concurrent_recovery_shares_one_limit(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            ledger = self._prepare(root, b"")
            with patch("video_factory.narration_subtitles.open_asset_request", side_effect=OSError("offline")) as download:
                capture_subtitle_evidence(ledger, root)
                recover_subtitles(ledger, root, self._assembled(),
                    narration_plan_sha256="c" * 64, adapter_version=INTERNAL_ADAPTER, refetch=True)
                self.assertEqual(download.call_count, 1, "没有新依据不重取")
                def recover(_):
                    return recover_subtitles(ledger, root, self._assembled(),
                        narration_plan_sha256="c" * 64, adapter_version=INTERNAL_ADAPTER,
                        refetch=True, refetch_reason="已修复网络路由")
                with ThreadPoolExecutor(max_workers=4) as pool:
                    results = list(pool.map(recover, range(4)))
                self.assertEqual(download.call_count, 2)
                self.assertTrue(all(result["status"] == "unavailable" for result in results))

    def test_explicit_recovery_can_capture_missing_first_fit_evidence_only_once(self):
        payload = json.dumps({"version": INTERNAL_ADAPTER,
            "cues": [{"start": 0.0, "end": 0.8, "text": "同步句。"}]}).encode()
        for failed in (False, True):
            with self.subTest(failed=failed), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                ledger = self._prepare(root, payload)
                def fetch(*args, **kwargs):
                    if failed:
                        raise OSError("still unavailable")
                    return io.BytesIO(payload)
                with patch("video_factory.narration_subtitles.open_asset_request", side_effect=fetch) as download:
                    for reason in (None, "   "):
                        recover_subtitles(ledger, root, self._assembled(), narration_plan_sha256="c" * 64,
                            adapter_version=INTERNAL_ADAPTER, refetch=True, refetch_reason=reason)
                    download.assert_not_called()
                    def recover(_):
                        return recover_subtitles(ledger, root, self._assembled(), narration_plan_sha256="c" * 64,
                            adapter_version=INTERNAL_ADAPTER, refetch=True,
                            refetch_reason="首次排轨在字幕捕获前停止；原响应字幕现可读取")
                    with ThreadPoolExecutor(max_workers=4) as pool:
                        results = list(pool.map(recover, range(4)))
                    self.assertEqual(download.call_count, 1, "显式恢复只核取原字幕一次，失败或并发不增加次数")
                    self.assertTrue(all(r["status"] == ("unavailable" if failed else "verified") for r in results))
                    capture_subtitle_evidence(ledger, root)
                    self.assertEqual(download.call_count, 1)
                receipt = json.loads(next((root / ".subtitle-evidence").glob("*.receipt.json")).read_text())
                self.assertEqual(receipt["refetchCount"], 1)

    def test_incomplete_group_coverage_and_wrong_audio_binding_cannot_claim_verified(self):
        payload = json.dumps({"version": INTERNAL_ADAPTER,
            "cues": [{"start": 0.0, "end": 0.8, "text": "同步句。"}]}).encode()
        for change in ("missing_group", "wrong_audio"):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                ledger = self._prepare(root, payload)
                assembled = self._assembled()
                if change == "missing_group":
                    assembled["groups"].append({**assembled["groups"][0], "id": "narration-2"})
                else:
                    assembled["groups"][0]["rawAudioSha256"] = "f" * 64
                with patch("video_factory.narration_subtitles.open_asset_request", return_value=io.BytesIO(payload)):
                    contract = build_group_subtitles(ledger, root, assembled,
                        narration_plan_sha256="c" * 64, adapter_version=INTERNAL_ADAPTER)
                self.assertNotEqual(contract["status"], "verified")
                self.assertEqual(contract["cues"], [])
