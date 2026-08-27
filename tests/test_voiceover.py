import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from video_factory.voiceover import scene_tempo, synthesize_minimax_audio


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
    def test_scene_tempo_preserves_voice_quality_with_a_bounded_speedup(self):
        self.assertEqual(scene_tempo(3.646, 1.9), 1.35)
        self.assertEqual(scene_tempo(1.5, 1.9), 1.0)
        self.assertEqual(scene_tempo(6.0, 1.9), 1.35)

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


if __name__ == "__main__":
    unittest.main()
