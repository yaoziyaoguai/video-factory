import json
import hashlib
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from video_factory.continuous_voiceover import assemble_narration_track
from video_factory.narration_plan import build_narration_plan
from video_factory.renderer import attach_voiceover_plan, burn_verified_subtitles, ffmpeg_filter_available, render_script_video, render_asset_video, write_render_manifest
from video_factory.narration_subtitles import cues_to_ass
from test_continuous_voiceover import tone


class ContinuousRenderingTest(unittest.TestCase):
    def test_detects_subtitle_filter_from_real_ffmpeg_columns_not_description(self):
        # FFmpeg 7/8分别有三位/两位能力标志；滤镜名在第二列，不在描述末尾。
        for flags in ("...", ".."):
            with self.subTest(flags=flags), patch.dict("video_factory.renderer._FFmpegFilterAvailability", {}, clear=True), \
                    patch("video_factory.renderer.subprocess.run", return_value=subprocess.CompletedProcess(
                        [], 0, stdout=f"Filters:\n {flags} ass V->V Render ASS subtitles onto input video using the libass library.\n"
                        f" {flags} scale V->V Scale the input video size.\n", stderr="")):
                self.assertTrue(ffmpeg_filter_available("ass"))
                self.assertFalse(ffmpeg_filter_available("subtitles"))

    def test_burns_real_timed_subtitle_pixels_when_libass_is_installed(self):
        # 独立询问FFmpeg，避免用待测能力检测决定是否跳过；Linux CI必须实际烧录。
        help_result = subprocess.run(["ffmpeg", "-hide_banner", "-h", "filter=ass"],
                                     check=True, capture_output=True, text=True)
        if "Filter ass\n" not in help_result.stdout:
            self.skipTest("Installed FFmpeg has no ass filter; Linux CI covers real subtitle burning")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "render"
            output.mkdir()
            track = root / "narration.wav"
            tone(track, 1)
            cues = [{"text": "真实字幕", "startSample": 0, "endSample": 22050}]
            ass = root / "narration.ass"
            ass.write_text(cues_to_ass(cues))
            plan = {"layoutKey": "a" * 64, "track_path": str(track),
                "trackSha256": hashlib.sha256(track.read_bytes()).hexdigest(),
                "subtitles": {"version": "video-factory/narration-subtitles-v1", "status": "verified",
                    "layoutKey": "a" * 64, "cues": cues, "sidecar": {"ass": ass.name},
                    "sidecarSha256": {"ass": hashlib.sha256(ass.read_bytes()).hexdigest()}}}
            clip = root / "plain.mp4"
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=navy:s=180x320:r=30",
                            "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(clip)], check=True)
            concat = root / "concat.txt"
            concat.write_text(f"file '{clip.as_posix()}'\n")
            manifest = {"slides": [{"duration": 1}], "resolution": "180x320", "voiceover_plan": plan}
            burned, result = burn_verified_subtitles(manifest, output, concat, output / "final.mp4")
            self.assertEqual(result["status"], "burned")
            self.assertTrue(burned.is_file())
            white_pixels = []
            for timestamp in ("0.25", "0.75"):
                frame = subprocess.run(["ffmpeg", "-v", "error", "-ss", timestamp, "-i", str(burned),
                    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                    check=True, capture_output=True).stdout
                self.assertEqual(len(frame), 180 * 320 * 3)
                white_pixels.append(sum(min(frame[index:index + 3]) > 200 for index in range(0, len(frame), 3)))
            self.assertGreater(white_pixels[0], 0, "字幕有效时间内必须有真实白色字形")
            self.assertEqual(white_pixels[1], 0, "字幕结束后不能仍残留在画面上")

    def test_subtitle_burn_checks_sidecar_identity_and_derives_output_geometry_without_mutating_original(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            voice_dir = root / "voice"
            output = root / "render"
            voice_dir.mkdir()
            output.mkdir()
            track = voice_dir / "narration.m4a"
            tone(track, 1)
            cues = [{"text": "有时间的字幕", "startSample": 0, "endSample": 22050}]
            ass = voice_dir / "narration.ass"
            ass.write_text(cues_to_ass(cues))
            original = ass.read_bytes()
            plan = {"layoutKey": "a" * 64, "track_path": str(track),
                "trackSha256": hashlib.sha256(track.read_bytes()).hexdigest(),
                "subtitles": {"version": "video-factory/narration-subtitles-v1", "status": "verified",
                    "layoutKey": "a" * 64, "cues": cues, "sidecar": {"ass": ass.name},
                    "sidecarSha256": {"ass": hashlib.sha256(original).hexdigest()}}}
            manifest = {"slides": [{"duration": 1}], "resolution": "180x320", "voiceover_plan": plan}
            with patch("video_factory.renderer.ffmpeg_filter_available", return_value=True), \
                    patch("video_factory.renderer.run_atomic_ffmpeg") as render:
                ass.write_text("changed")
                burned, result = burn_verified_subtitles(manifest, output, root / "concat.txt", output / "final.mp4")
                self.assertIsNone(burned)
                self.assertEqual(result["reason"], "subtitle_content_binding_mismatch")
                render.assert_not_called()
                ass.write_bytes(original)
                burned, result = burn_verified_subtitles(manifest, output, root / "concat.txt", output / "final.mp4")
                self.assertEqual(result["status"], "burned")
                derived = Path(result["assPath"])
                self.assertTrue(derived.is_relative_to(output))
                self.assertIn("PlayResX: 180\nPlayResY: 320", derived.read_text())
                self.assertEqual(ass.read_bytes(), original)
                command = render.call_args.args[0]
                self.assertIn("fps=30", command[command.index("-vf") + 1])

    def test_both_render_paths_keep_visual_cuts_and_do_not_display_scene_locked_subtitles(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            script = {"title": "连续声音", "duration_target": 20, "scenes": [
                {"position": position, "duration": duration, "narration": text,
                 "visual_strategy": "stock", "visual_prompt": "城市"}
                for position, duration, text in ((1, 6, "先看见，"), (2, 6, "再停下，"), (3, 8, "然后出发。"))]}
            script_path = root / "script.json"
            script["scenes"][0]["on_screen_text"] = "AI 示意，不是真实取证"
            script_path.write_text(json.dumps(script))
            plan = build_narration_plan(script["scenes"], script_sha256="a" * 64, visual_sha256="b" * 64)
            raw = root / "raw.wav"
            tone(raw, 20)
            voice = assemble_narration_track(plan, {"narration-1": raw}, root / "voice")
            voice["scenes"] = [{"position": scene["position"], "duration": scene["duration"]} for scene in script["scenes"]]
            voice["subtitles"] = {"status": "unavailable", "cues": []}
            image = root / "image.png"
            Image.new("RGB", (180, 320), "navy").save(image)
            assets = {"scene_assets": [{"scene_position": index, "media_type": "image", "provider": "pexels",
                "local_path": str(image)} for index in (1, 2, 3)]}
            for entry in ("script", "asset"):
                with self.subTest(entry=entry):
                    output = root / entry
                    manifest_path = write_render_manifest(1, script_path, output, "180x320")
                    attach_voiceover_plan(manifest_path, voice)
                    manifest = json.loads(manifest_path.read_text())
                    self.assertEqual(manifest["slides"][0]["text"], "AI 示意，不是真实取证",
                                     "必要画面说明必须保留，不能与旁白字幕一起删掉")
                    self.assertTrue(all(not slide["text"] for slide in manifest["slides"][1:]),
                                    "无真实cue时不能烧录逐镜旁白来冒充字幕")
                    self.assertEqual([slide["duration"] for slide in manifest["slides"]], [6, 6, 8])
                    if entry == "script":
                        result = render_script_video(manifest_path, output, "180x320")
                    else:
                        result = render_asset_video(manifest_path, output, assets, "180x320")
                    manifest = json.loads(manifest_path.read_text())
                    self.assertNotIn("-shortest", manifest["ffmpeg_command"])
                    probe = json.loads(subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(result)],
                        check=True, capture_output=True, text=True).stdout)
                    video = next(stream for stream in probe["streams"] if stream["codec_type"] == "video")
                    audio = next(stream for stream in probe["streams"] if stream["codec_type"] == "audio")
                    self.assertEqual(int(video["nb_frames"]), 600)
                    self.assertGreaterEqual(float(audio["duration"]), 19.98)


if __name__ == "__main__":
    unittest.main()
