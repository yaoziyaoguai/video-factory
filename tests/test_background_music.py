import hashlib
import json
import math
import shutil
import struct
import subprocess
import tempfile
import unittest
import wave
from pathlib import Path

from video_factory.background_music import mix_background_music
from video_factory.renderer import render_audio_input, render_job_manifest


@unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg required")
class BackgroundMusicTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.music = self.root / "music.wav"
        self.voice = self.root / "voice.wav"
        self.write_wave(self.music, lambda t: 0.25 * math.sin(2 * math.pi * 220 * t), 2)
        self.write_wave(self.voice, lambda t: 0.3 * math.sin(2 * math.pi * 1000 * t) if 1 < t < 3 else 0, 4)
        self.settings = {"path": str(self.music), "sha256": hashlib.sha256(self.music.read_bytes()).hexdigest(),
                         "volume": 0.25, "fadeInSeconds": 0, "fadeOutSeconds": 0, "ducking": False,
                         "licenseNote": "Test fixture generated locally"}

    def write_wave(self, target, sample, duration):
        with wave.open(str(target), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(44100)
            output.writeframes(b"".join(struct.pack("<h", round(sample(i / 44100) * 32767)) for i in range(duration * 44100)))

    def band_amplitude(self, target, start, duration=0.1):
        with wave.open(str(target), "rb") as audio:
            audio.setpos(round(start * audio.getframerate()))
            samples = struct.unpack("<" + "h" * round(duration * audio.getframerate()) * audio.getnchannels(),
                                    audio.readframes(round(duration * audio.getframerate())))[::audio.getnchannels()]
        return abs(sum(value * math.sin(2 * math.pi * 220 * i / 44100) for i, value in enumerate(samples))) / len(samples)

    def test_loop_exact_duration_and_voice_unchanged(self):
        before = self.voice.read_bytes()
        output = self.root / "mixed.wav"
        result = mix_background_music(self.settings, self.voice, 4, output)
        with wave.open(str(output), "rb") as audio:
            self.assertEqual(audio.getnframes(), 4 * 44100)
        self.assertGreater(self.band_amplitude(output, 3.6), 50)
        self.assertEqual(self.voice.read_bytes(), before)
        self.assertEqual(result["licenseNote"], self.settings["licenseNote"])
        self.assertEqual(render_audio_input({"background_music": result}), ["-i", str(output)])
        output.write_bytes(b"changed")
        with self.assertRaisesRegex(RuntimeError, "content changed"):
            render_audio_input({"background_music": result})

    def test_ducking_lowers_music_during_speech_and_recovers(self):
        normal, ducked = self.root / "normal.wav", self.root / "ducked.wav"
        mix_background_music(self.settings, self.voice, 4, normal)
        mix_background_music({**self.settings, "ducking": True}, self.voice, 4, ducked)
        self.assertLess(self.band_amplitude(ducked, 2.4), self.band_amplitude(normal, 2.4) * 0.7)
        self.assertGreater(self.band_amplitude(ducked, 3.8), self.band_amplitude(ducked, 2.4))

    def test_fades_no_voice_and_zero_volume(self):
        output = self.root / "faded.wav"
        mix_background_music({**self.settings, "fadeInSeconds": 1, "fadeOutSeconds": 1}, None, 4, output)
        self.assertLess(self.band_amplitude(output, 0), self.band_amplitude(output, 1.5) * 0.2)
        self.assertLess(self.band_amplitude(output, 3.9), self.band_amplitude(output, 1.5) * 0.2)
        mix_background_music({**self.settings, "volume": 0}, None, 4, output)
        self.assertEqual(self.band_amplitude(output, 1.5), 0)

    def test_bad_binding_and_invalid_mix_fail_before_render(self):
        for field, value in (("sha256", "0" * 64), ("volume", -1), ("volume", float("nan")), ("ducking", "yes")):
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                mix_background_music({**self.settings, field: value}, self.voice, 4, self.root / "bad.wav")
        self.assertFalse((self.root / "bad.wav").exists())

    def test_rendered_mp4_uses_selected_mix_and_no_music_preserves_narration(self):
        from PIL import Image
        script = self.root / "script.json"
        script.write_text(json.dumps({"title": "通用音乐接线", "duration_target": 4, "scenes": [
            {"position": 1, "duration": 4, "narration": "", "visual_strategy": "stock", "visual_prompt": "色块"}]}))
        image = self.root / "frame.png"
        Image.new("RGB", (180, 320), "navy").save(image)
        assets = self.root / "assets.json"
        assets.write_text(json.dumps({"scene_assets": [
            {"scene_position": 1, "media_type": "image", "provider": "pexels", "local_path": str(image)}]}))
        voice = self.root / "voice-plan.json"
        voice.write_text(json.dumps({"track_path": str(self.voice), "scenes": [{"position": 1, "duration": 4}]}))
        amplitudes = []
        for music in (None, self.settings):
            workspace = self.root / ("off" if music is None else "on")
            manifest = json.loads(render_job_manifest(1, script, workspace, require_assets=True,
                asset_plan_path=assets, voiceover_plan_path=voice, resolution="180x320", background_music=music).read_text())
            video = manifest["output_file"]
            probe = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-of", "json", video],
                check=True, capture_output=True, text=True).stdout)
            self.assertEqual(next(s for s in probe["streams"] if s["codec_type"] == "video")["nb_frames"], "120")
            extracted = workspace / "actual.wav"
            subprocess.run(["ffmpeg", "-v", "error", "-i", video, "-vn", "-ar", "44100", "-ac", "2", str(extracted)], check=True)
            amplitudes.append(self.band_amplitude(extracted, 3.6))
            self.assertEqual("background_music" in manifest, music is not None)
        self.assertLess(amplitudes[0], 2)
        self.assertGreater(amplitudes[1], 50)
