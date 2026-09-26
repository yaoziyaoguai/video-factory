import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from video_factory.continuous_voiceover import assemble_narration_track
from video_factory.narration_plan import build_narration_plan
from video_factory.renderer import attach_voiceover_plan, render_script_video, render_asset_video, write_render_manifest
from test_continuous_voiceover import tone


class ContinuousRenderingTest(unittest.TestCase):
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
