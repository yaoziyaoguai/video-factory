"""原生声音通过真实 worker/FFmpeg，不以伪造 WAV 证明媒体链。"""
import hashlib
import json
import subprocess
import tempfile
import unittest
import wave
from pathlib import Path

from video_factory.worker import handle_request
from video_factory.native_audio import NativeAudioError


class NativeAudioTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="vf-native-audio-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def request(self, capability="audio.prepare_native", *, audio=True, offset=0, audio_duration=9):
        sources = []
        for index in range(3):
            target = self.root / f"source-{index}.mp4"
            command = ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "color=blue:s=180x320:r=25:d=9"]
            if audio:
                command += ["-itsoffset", str(offset), "-f", "lavfi", "-i", f"sine=frequency={440 + index * 220}:sample_rate=48000:duration={audio_duration}", "-c:a", "aac"]
            command += ["-c:v", "libx264", "-preset", "ultrafast", str(target)]
            subprocess.run(command, check=True, capture_output=True, timeout=30)
            sources.append(target)
        cuts = [{"scenePosition": i + 1, "assetKey": f"asset-scene-{i + 1}", "startFrame": start, "frameCount": frames,
                 "sourceInFrame": 0} for i, (start, frames) in enumerate([(0, 180), (180, 210), (390, 210)])]
        script = {"title": "原生测试", "duration_target": 20, "scenes": [
            {"position": i + 1, "duration": cut["frameCount"] / 30, "narration": "这是预期台词，不是同步字幕。",
             "visual_strategy": "generated", "visual_prompt": "蓝色测试画面"} for i, cut in enumerate(cuts)]}
        executable = {"version": "video-factory/executable-plan-v1", "fps": 30, "totalFrames": 600,
                      "durationRange": {"minSeconds": 20, "maxSeconds": 20}, "cuts": cuts}
        assets = {"scene_assets": [{"scene_position": i + 1, "local_path": str(source), "provider": "wan",
            "asset_id": f"task-{i}", "media_type": "video", "width": 180, "height": 320, "duration": 9,
            "duration_frames": cuts[i]["frameCount"], "source_in_frame": 0, "asset_key": cuts[i]["assetKey"],
            "license_note": "Controlled fixture", "source_url": "https://example.com/fixture"} for i, source in enumerate(sources)]}
        inputs = {}
        for key, document in [("scriptPath", script), ("executablePlanPath", executable), ("assetPlanPath", assets)]:
            target = self.root / f"{key}.json"
            target.write_text(json.dumps(document), encoding="utf-8")
            inputs[key] = str(target)
        inputs["nativeInputIdentities"] = {key: {"uri": value, "sha256": self.sha(Path(value)), "artifactId": key}
            for key, value in inputs.copy().items()}
        inputs["nativeSourceIdentities"] = [{"uri": str(source), "sha256": self.sha(source), "artifactId": f"media-{i}"}
            for i, source in enumerate(sources)]
        return {"protocolVersion": "video-factory/worker-v1", "commandId": "prepare-original", "runId": "run-fixture",
            "nodeRunId": "voice", "attempt": 1, "capability": capability, "input": inputs,
            "parameters": {"providerId": "python-native-audio-v1", "mediaRoot": str(self.root)}, "outputDir": str(self.root / "voice")}

    @staticmethod
    def sha(file):
        return hashlib.sha256(file.read_bytes()).hexdigest()

    def test_native_worker_materializes_exact_track_from_current_sources_without_tts(self):
        request = self.request()
        result = handle_request(request)
        self.assertEqual(result["status"], "succeeded")
        plan = json.loads(Path(result["output"]["nativeAudioPlanPath"]).read_text())
        self.assertEqual(plan["version"], "video-factory/native-audio-plan-v1")
        self.assertEqual(plan["subtitles"]["status"], "unavailable")
        self.assertEqual(len(plan["segments"]), 3)
        with wave.open(plan["trackPath"], "rb") as track:
            self.assertEqual((track.getframerate(), track.getnchannels(), track.getnframes()), (44100, 2, 600 * 1470))
        self.assertEqual(plan["trackSha256"], self.sha(Path(plan["trackPath"])))
        self.assertEqual(result["diagnostics"]["meteredAttemptCount"], 0)
        self.assertFalse(any("voiceoverPlanPath" == key for key in result["output"]))
        self.assertFalse(list(self.root.rglob("*.vtt")))

    def test_native_track_reaches_real_render_without_fake_subtitles_or_silent_fallback(self):
        request = self.request()
        prepared = handle_request(request)
        rendered = handle_request({**request, "commandId": "render-current", "nodeRunId": "render", "capability": "video.render",
            "outputDir": str(self.root / "render"), "parameters": {"mediaRoot": str(self.root), "resolution": "180x320"},
            "input": {**request["input"], "audioMode": "native_av", "nativeAudioPlanPath": prepared["output"]["nativeAudioPlanPath"]}})
        self.assertEqual(rendered["status"], "succeeded")
        self.assertEqual(rendered["output"]["subtitleStatus"], "unavailable")
        video = Path(rendered["output"]["videoPath"])
        subprocess.run(["ffmpeg", "-v", "error", "-xerror", "-i", str(video), "-f", "null", "-"], check=True, capture_output=True, timeout=60)
        manifest = json.loads(Path(rendered["output"]["renderManifestPath"]).read_text())
        self.assertEqual(manifest["audioMode"], "native_av")
        self.assertNotIn("anullsrc", " ".join(manifest["ffmpeg_command"]))
        self.assertNotIn("-shortest", manifest["ffmpeg_command"])
        self.assertTrue(all(s["text"] == "" for s in manifest["slides"]))
        self.assertEqual(manifest["native_audio_plan"]["trackSha256"], self.sha(Path(manifest["native_audio_plan"]["trackPath"])))

    def test_missing_or_short_audio_stops_with_specific_recoverable_report(self):
        for options, expected in [({"audio": False}, "missing_audio"), ({"offset": 1}, "audio_range_insufficient"),
                                  ({"audio_duration": 2}, "audio_range_insufficient")]:
            with self.subTest(expected=expected, options=options):
                request = self.request(**options)
                result = handle_request(request)
                self.assertEqual(result["status"], "rejected")
                self.assertEqual(result["error"]["code"], "NATIVE_AUDIO_UNAVAILABLE")
                self.assertEqual(result["output"]["nativeAudioIssue"], expected)
                self.assertNotIn("nativeAudioPlanPath", result["output"])
                self.assertTrue(all(Path(a["uri"]).exists() for a in request["input"]["nativeSourceIdentities"]))
                self.assertEqual(result["diagnostics"]["meteredAttemptCount"], 0)

    def test_sha_change_and_path_escape_cannot_be_adopted(self):
        request = self.request()
        source = Path(request["input"]["nativeSourceIdentities"][0]["uri"])
        source.write_bytes(source.read_bytes() + b"changed")
        result = handle_request(request)
        self.assertEqual(result["output"]["nativeAudioIssue"], "invalid_binding")
        request["parameters"]["mediaRoot"] = str(self.root / "voice")
        self.assertEqual(handle_request(request)["output"]["nativeAudioIssue"], "invalid_binding")

    def test_internal_audio_timestamp_gap_is_not_silently_collapsed(self):
        request = self.request()
        source = Path(request["input"]["nativeSourceIdentities"][0]["uri"])
        replacement = self.root / "gap.mp4"
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(source), "-af",
            "asetpts=PTS+gte(T\\,3)/TB", "-c:v", "copy", "-c:a", "aac", str(replacement)],
            check=True, capture_output=True, timeout=30)
        source.write_bytes(replacement.read_bytes())
        request["input"]["nativeSourceIdentities"][0]["sha256"] = self.sha(source)
        result = handle_request(request)
        self.assertEqual(result["status"], "rejected", result)
        self.assertEqual(result["output"]["nativeAudioIssue"], "audio_timeline_discontinuous")
        self.assertEqual(result["diagnostics"]["meteredAttemptCount"], 0)

    def test_nonzero_audio_start_is_mapped_to_the_same_video_cut(self):
        request = self.request(offset=1)
        for key in ("assetPlanPath", "executablePlanPath"):
            target = Path(request["input"][key])
            document = json.loads(target.read_text())
            for item in document["scene_assets" if key == "assetPlanPath" else "cuts"]:
                item["source_in_frame" if key == "assetPlanPath" else "sourceInFrame"] = 30
            target.write_text(json.dumps(document))
            request["input"]["nativeInputIdentities"][key]["sha256"] = self.sha(target)
        result = handle_request(request)
        self.assertEqual(result["status"], "succeeded", result)

        plan = json.loads(Path(result["output"]["nativeAudioPlanPath"]).read_text())
        self.assertGreater(plan["sources"][0]["audioStartSeconds"] - plan["sources"][0]["videoStartSeconds"], 0.9)
        self.assertTrue(all(segment["sourceInFrame"] == 30 for segment in plan["segments"]))
        # 与同一音频流的实解码区间比对，证明没有把视频时间直接当PCM索引。
        raw = subprocess.run(["ffmpeg", "-v", "error", "-i", request["input"]["nativeSourceIdentities"][0]["uri"],
            "-map", "0:a:0", "-ac", "2", "-ar", "44100", "-f", "s16le", "pipe:1"], check=True, capture_output=True).stdout
        offset = plan["sources"][0]["audioStartSeconds"] - plan["sources"][0]["videoStartSeconds"]
        start = round((1 - offset) * 44100)
        with wave.open(plan["segments"][0]["path"], "rb") as segment:
            self.assertEqual(segment.readframes(segment.getnframes()), raw[start * 4:(start + 180 * 1470) * 4])

    def test_invalid_current_asset_structure_keeps_a_recoverable_native_stop(self):
        request = self.request()
        target = Path(request["input"]["assetPlanPath"])
        document = json.loads(target.read_text())
        document["scene_assets"].pop()
        target.write_text(json.dumps(document))
        request["input"]["nativeInputIdentities"]["assetPlanPath"]["sha256"] = self.sha(target)
        result = handle_request(request)
        self.assertEqual(result["status"], "rejected", result)
        self.assertEqual(result["output"]["nativeAudioIssue"], "invalid_binding")
        self.assertEqual(result["diagnostics"]["meteredAttemptCount"], 0)

    def test_ambiguous_damaged_and_short_video_are_never_silently_repaired(self):
        for mode, expected in [("multiple_audio", "audio_stream_ambiguous"), ("damaged", "audio_decode_failed"),
                               ("short_video", "source_range_insufficient")]:
            with self.subTest(mode=mode):
                request = self.request()
                source = Path(request["input"]["nativeSourceIdentities"][0]["uri"])
                if mode == "damaged":
                    source.write_bytes(b"not an mp4")
                else:
                    target = self.root / "replacement.mp4"
                    args = ["-map", "0:v", "-map", "0:a", "-map", "0:a"] if mode == "multiple_audio" else ["-t", "1"]
                    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(source), *args, "-c", "copy", str(target)],
                        check=True, capture_output=True, timeout=30)
                    source.write_bytes(target.read_bytes())
                request["input"]["nativeSourceIdentities"][0]["sha256"] = self.sha(source)
                result = handle_request(request)
                self.assertEqual(result["status"], "rejected", result)
                self.assertEqual(result["output"]["nativeAudioIssue"], expected)
                self.assertEqual(result["diagnostics"]["meteredAttemptCount"], 0)

    def test_render_rejects_old_plan_after_current_source_or_cut_changes(self):
        request = self.request()
        prepared = handle_request(request)
        plan_path = prepared["output"]["nativeAudioPlanPath"]
        for key, list_key, field in [("executablePlanPath", "cuts", "sourceInFrame"), ("assetPlanPath", "scene_assets", "source_in_frame")]:
            target = Path(request["input"][key])
            document = json.loads(target.read_text())
            document[list_key][0][field] = 1
            target.write_text(json.dumps(document))
            request["input"]["nativeInputIdentities"][key]["sha256"] = self.sha(target)
        with self.assertRaisesRegex(NativeAudioError, "原声计划不属于当前"):
            handle_request({**request, "commandId": "stale-render", "nodeRunId": "render", "capability": "video.render",
                "outputDir": str(self.root / "render"), "parameters": {"mediaRoot": str(self.root), "resolution": "180x320"},
                "input": {**request["input"], "audioMode": "native_av", "nativeAudioPlanPath": plan_path}})
        self.assertFalse(list((self.root / "render").glob("*.mp4")))


if __name__ == "__main__":
    unittest.main()
