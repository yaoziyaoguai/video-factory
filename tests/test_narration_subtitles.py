import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from video_factory.narration_subtitles import capture_subtitle_evidence


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
