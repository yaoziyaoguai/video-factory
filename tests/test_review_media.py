import hashlib
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from video_factory.review_media import (
    MAX_FRAME_BYTES,
    MAX_TOTAL_FRAME_BYTES,
    _probe_video,
    _select_render_timeline_timestamps,
    prepare_asset_review_media,
    prepare_review_media,
)


FFMPEG_AVAILABLE = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


@unittest.skipUnless(FFMPEG_AVAILABLE, "FFmpeg and ffprobe are required")
class ReviewMediaTest(unittest.TestCase):
    def test_source_review_binds_nonzero_sampling_to_the_executable_cut(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = root / "master.mp4"
            video.write_bytes(b"test video")
            executable_plan_path = root / "executable_plan.json"
            executable_plan_path.write_text(json.dumps({
                "version": "video-factory/executable-plan-v1",
                "durationRange": {"minSeconds": 20, "maxSeconds": 20},
                "fps": 30,
                "totalFrames": 600,
                "cuts": [{
                    "scenePosition": 1, "beatId": "scene-1", "assetKey": "master-1",
                    "startFrame": 0, "frameCount": 600, "sourceInFrame": 120,
                }],
            }), encoding="utf-8")
            plan = root / "asset_plan.json"
            scene_asset = {
                "scene_position": 1, "duration_frames": 600, "source_in_frame": 120,
                "asset_key": "master-1", "media_type": "video", "local_path": str(video),
            }
            plan.write_text(json.dumps({"scene_assets": [scene_asset]}), encoding="utf-8")
            extracted = []

            def extract(_video, source_start, source_end, timestamp, target):
                extracted.append((source_start, source_end, timestamp))
                Image.new("RGB", (320, 480), "green").save(target, format="JPEG")

            with patch("video_factory.review_media._probe_video", return_value={"duration": 24}), patch(
                "video_factory.review_media._extract_frame_from_range", side_effect=extract
            ):
                manifest = json.loads(prepare_asset_review_media(
                    plan, root, executable_plan_path=executable_plan_path
                ).read_text(encoding="utf-8"))
            # 只有这一场，整笔帧预算都归它；每一次取帧都必须绑定在可执行剪辑的源区间上。
            self.assertEqual(len(extracted), 24)
            self.assertEqual({(start, end) for start, end, _ in extracted}, {(4, 24)})
            timecodes = [frame["sourceTimecodeMs"] for frame in manifest["frames"]]
            self.assertEqual([timestamp for _, _, timestamp in extracted], timecodes)
            self.assertEqual(timecodes, [
                4417, 5250, 6083, 6917, 7750, 8583, 9417, 10250, 11083, 11917, 12750, 13583,
                14417, 15250, 16083, 16917, 17750, 18583, 19417, 20250, 21083, 21917, 22750, 23583,
            ])
            self.assertEqual(timecodes, sorted(set(timecodes)))
            self.assertEqual(manifest["sampling"]["mode"], "scene_sequence")

            plan.write_text(json.dumps({"scene_assets": [{
                **scene_asset, "asset_key": "stale-master",
            }]}), encoding="utf-8")
            with patch("video_factory.review_media._extract_frame_from_range") as extract:
                with self.assertRaisesRegex(ValueError, "Asset plan.*executable production cuts"):
                    prepare_asset_review_media(plan, root, executable_plan_path=executable_plan_path)
                extract.assert_not_called()
    def test_source_review_probe_uses_video_stream_duration_not_a_longer_container_duration(self):
        payload = {
            "streams": [{"width": 320, "height": 480, "duration": "2.000000"}],
            "format": {"duration": "10.000000"},
        }
        with patch("video_factory.review_media.subprocess.run") as run:
            run.return_value = subprocess.CompletedProcess([], 0, json.dumps(payload), "")
            self.assertEqual(_probe_video(Path("source.mp4")), {"duration": 2.0})

        command = run.call_args.args[0]
        self.assertIn("stream=width,height,duration", command)

    def test_source_review_samples_only_the_compiled_nonzero_source_range_and_records_both_timecodes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = root / "master.mp4"
            video.write_bytes(b"test video")
            plan = root / "asset_plan.json"
            plan.write_text(json.dumps({"scene_assets": [{
                "scene_position": 1,
                "duration": 10,
                "duration_frames": 60,
                "source_in_frame": 120,
                "asset_key": "master-1",
                "media_type": "video",
                "local_path": str(video),
            }]}), encoding="utf-8")
            extracted = []

            def extract(_video, source_start, source_end, timestamp, target):
                extracted.append((source_start, source_end, timestamp))
                Image.new("RGB", (320, 480), "green").save(target, format="JPEG")

            with patch("video_factory.review_media._probe_video", return_value={"duration": 6}), patch(
                "video_factory.review_media._extract_frame_from_range", side_effect=extract
            ):
                manifest = json.loads(prepare_asset_review_media(plan, root).read_text(encoding="utf-8"))

            self.assertEqual(manifest["durationMs"], 2000)
            self.assertEqual(len(extracted), 24)
            self.assertEqual({(start, end) for start, end, _ in extracted}, {(4, 6)})
            self.assertEqual(
                [timestamp for _, _, timestamp in extracted],
                [4042, 4125, 4208, 4292, 4375, 4458, 4542, 4625, 4708, 4792, 4875, 4958,
                 5042, 5125, 5208, 5292, 5375, 5458, 5542, 5625, 5708, 5792, 5875, 5958],
            )
            timestamps = [frame["timestampMs"] for frame in manifest["frames"]]
            timecodes = [frame["sourceTimecodeMs"] for frame in manifest["frames"]]
            self.assertEqual(timecodes, [timestamp for _, _, timestamp in extracted])
            self.assertEqual(timestamps, [
                42, 125, 208, 292, 375, 458, 542, 625, 708, 792, 875, 958,
                1042, 1125, 1208, 1292, 1375, 1458, 1542, 1625, 1708, 1792, 1875, 1958,
            ])
            # 两个时间码必须同时记录，并且差值恒等于这一场的源入点。
            self.assertEqual(
                [timecode - timestamp for timestamp, timecode in zip(timestamps, timecodes)],
                [4000] * 24,
            )

    def test_source_review_extracts_only_frames_inside_the_selected_color_range(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = root / "color-master.mp4"
            make_color_range_video(video)
            plan = root / "asset_plan.json"
            plan.write_text(json.dumps({"scene_assets": [{
                "scene_position": 1,
                "duration_frames": 60,
                "source_in_frame": 60,
                "asset_key": "green-segment",
                "media_type": "video",
                "local_path": str(video),
            }]}), encoding="utf-8")

            manifest = json.loads(prepare_asset_review_media(plan, root).read_text(encoding="utf-8"))

            timecodes = [frame["sourceTimecodeMs"] for frame in manifest["frames"]]
            self.assertEqual(timecodes, [
                2042, 2125, 2208, 2292, 2375, 2458, 2542, 2625, 2708, 2792, 2875, 2958,
                3042, 3125, 3208, 3292, 3375, 3458, 3542, 3625, 3708, 3792, 3875, 3958,
            ])
            # green 段是源 2.0 至 4.0 秒；采样点一个都不能越出这段可选范围。
            self.assertTrue(all(2000 <= timecode < 4000 for timecode in timecodes))
            for frame in manifest["frames"]:
                with Image.open(root / frame["path"]) as image:
                    red, green, blue = image.convert("RGB").resize((1, 1)).getpixel((0, 0))
                self.assertGreater(green, red * 2)
                self.assertGreater(green, blue * 2)

    def test_source_review_rejects_ranges_not_covered_by_the_source_and_image_offsets(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = root / "master.mp4"
            video.write_bytes(b"test video")
            image = root / "still.png"
            Image.new("RGB", (16, 16), "blue").save(image)
            plan = root / "asset_plan.json"

            plan.write_text(json.dumps({"scene_assets": [{
                "scene_position": 1, "duration_frames": 61, "source_in_frame": 120,
                "media_type": "video", "local_path": str(video),
            }]}), encoding="utf-8")
            with patch("video_factory.review_media._probe_video", return_value={"duration": 6}):
                with self.assertRaisesRegex(ValueError, "does not cover the planned source range"):
                    prepare_asset_review_media(plan, root)

            plan.write_text(json.dumps({"scene_assets": [{
                "scene_position": 1, "duration_frames": 30, "source_in_frame": 1,
                "media_type": "image", "local_path": str(image),
            }]}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "image source offset"):
                prepare_asset_review_media(plan, root)

    def test_source_review_rejects_explicit_invalid_compiled_frame_counts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            image = root / "still.png"
            Image.new("RGB", (16, 16), "blue").save(image)
            plan = root / "asset_plan.json"
            for invalid in (0, -1, 1.5, True, "30"):
                with self.subTest(duration_frames=invalid):
                    plan.write_text(json.dumps({"scene_assets": [{
                        "scene_position": 1, "duration": 3, "duration_frames": invalid,
                        "source_in_frame": 0, "media_type": "image", "local_path": str(image),
                    }]}), encoding="utf-8")
                    with self.assertRaisesRegex(ValueError, "duration_frames is invalid"):
                        prepare_asset_review_media(plan, root)

    def test_source_review_uses_only_the_duration_used_by_the_edit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = root / "long.mp4"
            video.write_bytes(b"test video")
            script = root / "script.json"
            script.write_text(json.dumps({"scenes": [{"position": 1, "duration": 2}]}), encoding="utf-8")
            plan = root / "asset_plan.json"
            plan.write_text(json.dumps({"scene_assets": [
                {"scene_position": 1, "duration": 10, "media_type": "video", "local_path": str(video)},
            ]}), encoding="utf-8")
            timestamps = []

            def extract(_video, _source_start, _source_end, timestamp, target):
                timestamps.append(timestamp)
                Image.new("RGB", (320, 480), "blue").save(target, format="JPEG")

            with patch("video_factory.review_media._probe_video", return_value={"duration": 10}), patch(
                "video_factory.review_media._extract_frame_from_range", side_effect=extract
            ):
                manifest = json.loads(prepare_asset_review_media(plan, root, script_path=script).read_text(encoding="utf-8"))
            # 剪辑只用 2 秒，plan 里写的 10 秒不得成为采样范围的一部分。
            self.assertEqual(manifest["durationMs"], 2000)
            self.assertEqual(timestamps, [
                42, 125, 208, 292, 375, 458, 542, 625, 708, 792, 875, 958,
                1042, 1125, 1208, 1292, 1375, 1458, 1542, 1625, 1708, 1792, 1875, 1958,
            ])
            self.assertEqual(timestamps, sorted(set(timestamps)))
            self.assertGreaterEqual(timestamps[0], 0)
            self.assertLess(timestamps[-1], manifest["durationMs"])

    def test_pilot_video_uses_the_full_frame_budget_as_an_ordered_sequence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = root / "pilot.mp4"
            video.write_bytes(b"test video")
            plan = root / "asset_plan.json"
            plan.write_text(json.dumps({"scene_assets": [
                {
                    "scene_position": position,
                    "duration": 5,
                    "media_type": "video",
                    "local_path": str(video) if position == 6 else "",
                }
                for position in range(1, 9)
            ]}), encoding="utf-8")
            timestamps = []

            def extract(_video, _source_start, _source_end, timestamp, target):
                timestamps.append(timestamp)
                Image.new("RGB", (320, 480), "blue").save(target, format="JPEG")

            with patch("video_factory.review_media._probe_video", return_value={"duration": 5}), patch(
                "video_factory.review_media._extract_frame_from_range", side_effect=extract
            ):
                manifest = json.loads(prepare_asset_review_media(
                    plan, root, scene_positions=[6]
                ).read_text(encoding="utf-8"))

            self.assertEqual(len(timestamps), 24)
            self.assertEqual(timestamps, sorted(set(timestamps)))
            self.assertLess(timestamps[0], 250)
            self.assertGreater(timestamps[-1], 4750)
            self.assertEqual(manifest["sampling"]["mode"], "scene_sequence")
            self.assertEqual(manifest["sampling"]["coveredScenePositions"], [6])
            self.assertEqual(manifest["sampling"]["missingScenePositions"], [1, 2, 3, 4, 5, 7, 8])
            self.assertEqual(manifest["frames"][0]["phase"], "opening")
            self.assertTrue(all(frame["phase"] == "middle" for frame in manifest["frames"][1:-1]))
            self.assertEqual(manifest["frames"][-1]["phase"], "closing")

    def test_full_source_review_spends_the_whole_frame_budget_as_an_ordered_sequence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            video = root / "master.mp4"
            video.write_bytes(b"test video")
            plan = root / "asset_plan.json"
            # 与真实主片同形：5 场、按 30fps 编译的帧数、总时长 24 秒。
            plan.write_text(json.dumps({"scene_assets": [
                {
                    "scene_position": position,
                    "duration_frames": duration_frames,
                    "media_type": "video",
                    "local_path": str(video),
                }
                for position, duration_frames in enumerate([135, 45, 135, 180, 225], start=1)
            ]}), encoding="utf-8")

            def extract(_video, _source_start, _source_end, timestamp, target):
                Image.new("RGB", (320, 480), "blue").save(target, format="JPEG")

            with patch("video_factory.review_media._probe_video", return_value={"duration": 10}), patch(
                "video_factory.review_media._extract_frame_from_range", side_effect=extract
            ):
                manifest = json.loads(prepare_asset_review_media(plan, root).read_text(encoding="utf-8"))

            frames = manifest["frames"]
            self.assertEqual(len(frames), 24)
            # 全片预检与试片共用同一套审片合同，预算不能只花一半：稀疏到采不到场内的
            # 动作窗口时，审片只能报 not_observed，预检会在配音与渲染前停住主角片。
            durations_ms = {position: round(frames_count * 1000 / 30) for position, frames_count in
                            enumerate([135, 45, 135, 180, 225], start=1)}
            for position in range(1, 6):
                scene = sorted(
                    (frame for frame in frames if frame["scenePosition"] == position),
                    key=lambda frame: frame["sourceTimecodeMs"],
                )
                self.assertGreaterEqual(len(scene), 3, f"scene {position} lost its coarse coverage")
                self.assertEqual(scene[0]["phase"], "opening")
                self.assertEqual(scene[-1]["phase"], "closing")
                # 场首到场尾之间不得留下超过 1/3 场长的空白窗口。
                edges = [0, *(frame["sourceTimecodeMs"] for frame in scene), durations_ms[position]]
                widest = max(right - left for left, right in zip(edges, edges[1:]))
                self.assertLessEqual(
                    widest, durations_ms[position] // 3, f"scene {position} still has a blind window"
                )
            self.assertEqual(manifest["sampling"]["mode"], "scene_sequence")

    def test_pilot_reviews_only_selected_materialized_scene_and_preserves_its_position(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            image_path = root / "scene-2.png"
            Image.new("RGB", (320, 480), "blue").save(image_path)
            plan_path = root / "asset_plan.json"
            plan_path.write_text(json.dumps({"scene_assets": [
                {"scene_position": 1, "duration": 4, "media_type": "video", "local_path": ""},
                {"scene_position": 2, "duration": 4, "media_type": "image", "local_path": str(image_path)},
                {"scene_position": 3, "duration": 4, "media_type": "video", "local_path": ""},
            ]}), encoding="utf-8")
            manifest_path = prepare_asset_review_media(plan_path, root, scene_positions=[2])
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest["sampling"]["sceneCount"], 3)
            self.assertEqual(manifest["sampling"]["coveredScenePositions"], [2])
            self.assertEqual(manifest["sampling"]["missingScenePositions"], [1, 3])
            self.assertEqual([frame["scenePosition"] for frame in manifest["frames"]], [2])
            for positions in ([], [2, 2], [4]):
                with self.assertRaisesRegex(ValueError, "pilot scene positions are invalid"):
                    prepare_asset_review_media(plan_path, root, scene_positions=positions)
            # 整批预检仍必须拒绝缺失的素材，不能因为支持试片而放松整片检查。
            with self.assertRaises((ValueError, IsADirectoryError)):
                prepare_asset_review_media(plan_path, root)

    def test_prepares_every_source_asset_before_rendering(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_root = Path(tmp) / "run-1"
            assets_dir = run_root / "assets"
            assets_dir.mkdir(parents=True)
            first = assets_dir / "scene-1.png"
            second = assets_dir / "scene-2.png"
            Image.new("RGB", (320, 480), "red").save(first)
            Image.new("RGB", (320, 480), "blue").save(second)
            plan_path = assets_dir / "asset_plan.json"
            plan_path.write_text(json.dumps({
                "scene_assets": [
                    {"scene_position": 1, "duration": 4, "media_type": "image", "local_path": str(first)},
                    {"scene_position": 2, "duration": 6, "media_type": "image", "local_path": str(second)},
                ],
            }), encoding="utf-8")

            manifest_path = prepare_asset_review_media(plan_path, run_root)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

            self.assertEqual(manifest["durationMs"], 10_000)
            self.assertEqual(manifest["sampling"]["sceneCount"], 2)
            self.assertEqual([frame["scenePosition"] for frame in manifest["frames"]], [1, 2])
            self.assertEqual([frame["timestampMs"] for frame in manifest["frames"]], [2_000, 7_000])
            self.assertEqual([frame["phase"] for frame in manifest["frames"]], ["midpoint", "midpoint"])
            for frame in manifest["frames"]:
                assert_manifest_image(run_root, frame)

    def test_rejects_source_assets_outside_the_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            run_root = root / "run-1"
            run_root.mkdir()
            outside = root / "outside.png"
            Image.new("RGB", (16, 16), "red").save(outside)
            plan_path = run_root / "asset_plan.json"
            plan_path.write_text(json.dumps({
                "scene_assets": [{
                    "scene_position": 1,
                    "duration": 4,
                    "media_type": "image",
                    "local_path": str(outside),
                }],
            }), encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "asset local_path must stay within run_root"):
                prepare_asset_review_media(plan_path, run_root)

    def test_prepares_deterministic_run_relative_review_media(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_root = Path(tmp) / "run-1"
            video_path = run_root / "render" / "final.mp4"
            make_test_video(video_path)

            manifest_path = prepare_review_media(video_path=video_path, run_root=run_root)
            first_manifest_bytes = manifest_path.read_bytes()
            manifest = json.loads(first_manifest_bytes)

            self.assertEqual(
                manifest_path,
                (run_root / "review_media" / "review_media_manifest.json").resolve(),
            )
            self.assertEqual(manifest["version"], "video-factory/review-media-v1")
            self.assertEqual(manifest["sampling"], {"mode": "scene_change_keyframes"})
            self.assertGreater(manifest["durationMs"], 0)
            self.assertGreaterEqual(len(manifest["frames"]), 3)
            self.assertLessEqual(len(manifest["frames"]), 24)
            self.assertNotIn(str(run_root), first_manifest_bytes.decode("utf-8"))

            timestamps = [frame["timestampMs"] for frame in manifest["frames"]]
            self.assertEqual(timestamps, sorted(set(timestamps)))
            for frame in manifest["frames"]:
                self.assertEqual(set(frame), {"path", "timestampMs", "sha256", "width", "height", "phase"})
                self.assertEqual(frame["phase"], "keyframe")
                assert_manifest_image(run_root, frame)
                self.assertLessEqual((run_root / frame["path"]).stat().st_size, MAX_FRAME_BYTES)
            self.assertLessEqual(
                sum((run_root / frame["path"]).stat().st_size for frame in manifest["frames"]),
                MAX_TOTAL_FRAME_BYTES,
            )

            contact_sheet = manifest["contactSheet"]
            self.assertEqual(set(contact_sheet), {"path", "sha256", "width", "height"})
            assert_manifest_image(run_root, contact_sheet)

            second_manifest_path = prepare_review_media(video_path=video_path, run_root=run_root)
            self.assertEqual(second_manifest_path.read_bytes(), first_manifest_bytes)
            second_manifest = json.loads(second_manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(second_manifest["contactSheet"]["sha256"], contact_sheet["sha256"])

    def test_prioritizes_scene_changes_then_fills_the_full_timeline(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_root = Path(tmp) / "run-1"
            video_path = run_root / "render" / "final.mp4"
            make_test_video(video_path)

            manifest_path = prepare_review_media(
                video_path=video_path,
                run_root=run_root,
                max_frames=5,
            )
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            timestamps = [frame["timestampMs"] for frame in manifest["frames"]]

            self.assertEqual(len(timestamps), 5)
            self.assertIn(1000, timestamps)
            self.assertIn(2000, timestamps)
            self.assertTrue(any(timestamp < 1000 for timestamp in timestamps))
            self.assertTrue(any(timestamp > 2000 for timestamp in timestamps))

    def test_evenly_reduces_scene_changes_to_the_twelve_frame_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_root = Path(tmp) / "run-1"
            video_path = run_root / "render" / "final.mp4"
            make_many_scene_video(video_path, segment_count=15)

            manifest_path = prepare_review_media(video_path=video_path, run_root=run_root)
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            timestamps = [frame["timestampMs"] for frame in manifest["frames"]]

            self.assertEqual(len(timestamps), 12)
            self.assertTrue(all(timestamp % 1000 == 0 for timestamp in timestamps))
            self.assertGreaterEqual(timestamps[-1], 14_000)

    def test_uses_render_timeline_midpoints_and_preserves_the_first_screen(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_root = Path(tmp) / "run-1"
            video_path = run_root / "render" / "final.mp4"
            render_manifest_path = run_root / "render" / "render_manifest.json"
            make_test_video(video_path)
            render_manifest_path.write_text(
                json.dumps({
                    "slides": [
                        {"position": 1, "duration": 1},
                        {"position": 2, "duration": 1},
                        {"position": 3, "duration": 1},
                    ],
                }),
                encoding="utf-8",
            )

            manifest_path = prepare_review_media(
                video_path=video_path,
                run_root=run_root,
                max_frames=4,
                render_manifest_path=render_manifest_path,
            )
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

            self.assertEqual(
                [frame["timestampMs"] for frame in manifest["frames"]],
                [250, 500, 1500, 2500],
            )
            self.assertEqual(manifest["sampling"], {
                "mode": "hook_and_scene_midpoints",
                "sceneCount": 3,
                "coveredScenePositions": [1, 2, 3],
                "missingScenePositions": [],
            })
            self.assertEqual([frame["phase"] for frame in manifest["frames"]], ["hook", "midpoint", "midpoint", "midpoint"])
            self.assertEqual([frame["scenePosition"] for frame in manifest["frames"]], [1, 1, 2, 3])

    def test_scales_render_timeline_to_the_probed_video_duration(self):
        self.assertEqual(
            _select_render_timeline_timestamps(12_000, [2, 2, 2], 4),
            [250, 2000, 6000, 10000],
        )
        self.assertEqual(
            _select_render_timeline_timestamps(12_000, [2, 2, 2], 1),
            [250],
        )

    def test_uses_start_middle_end_context_for_every_scene_when_budget_allows(self):
        timestamps = _select_render_timeline_timestamps(24_000, [3] * 8, 24)

        self.assertEqual(len(timestamps), 24)
        self.assertEqual(timestamps[:3], [450, 1500, 2550])
        self.assertEqual(timestamps[-3:], [21450, 22500, 23550])

    def test_manifest_labels_true_triplets_instead_of_claiming_sparse_samples_are_triplets(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_root = Path(tmp) / "run-1"
            video_path = run_root / "render" / "final.mp4"
            render_manifest_path = run_root / "render" / "render_manifest.json"
            make_test_video(video_path)
            render_manifest_path.write_text(
                json.dumps({"slides": [{"duration": 1}, {"duration": 1}, {"duration": 1}]}),
                encoding="utf-8",
            )

            manifest_path = prepare_review_media(
                video_path=video_path,
                run_root=run_root,
                max_frames=9,
                render_manifest_path=render_manifest_path,
            )
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

            self.assertEqual(manifest["sampling"], {
                "mode": "scene_triplets",
                "sceneCount": 3,
                "coveredScenePositions": [1, 2, 3],
                "missingScenePositions": [],
            })
            self.assertEqual([frame["phase"] for frame in manifest["frames"][:3]], ["opening", "middle", "closing"])
            self.assertEqual([frame["scenePosition"] for frame in manifest["frames"]], [1, 1, 1, 2, 2, 2, 3, 3, 3])

    def test_long_render_timeline_keeps_the_hook_and_scene_range(self):
        timestamps = _select_render_timeline_timestamps(30_000, [1] * 30, 12)

        self.assertEqual(len(timestamps), 12)
        self.assertEqual(timestamps[0], 250)
        self.assertIn(500, timestamps)
        self.assertIn(29_500, timestamps)

    def test_rejects_non_numeric_render_durations(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_root = Path(tmp) / "run-1"
            video_path = run_root / "render" / "final.mp4"
            render_manifest_path = run_root / "render" / "render_manifest.json"
            make_test_video(video_path)

            for invalid_duration in (True, "1.5"):
                with self.subTest(duration=invalid_duration):
                    render_manifest_path.write_text(
                        json.dumps({"slides": [{"duration": invalid_duration}]}),
                        encoding="utf-8",
                    )
                    with self.assertRaisesRegex(ValueError, "duration is invalid"):
                        prepare_review_media(
                            video_path=video_path,
                            run_root=run_root,
                            render_manifest_path=render_manifest_path,
                        )

    def test_rejects_direct_and_symlinked_paths_outside_the_run_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            run_root = root / "run-1"
            run_root.mkdir()
            outside_video = root / "outside.mp4"
            outside_video.write_bytes(b"not inspected")
            symlinked_video = run_root / "linked.mp4"
            symlinked_video.symlink_to(outside_video)

            for video_path in (outside_video, symlinked_video):
                with self.subTest(video_path=video_path):
                    with self.assertRaisesRegex(ValueError, "must stay within run_root"):
                        prepare_review_media(video_path=video_path, run_root=run_root)

            self.assertFalse((run_root / "review_media").exists())
            self.assertEqual(list(run_root.glob(".review-media-*")), [])

    def test_reencodes_an_oversized_frame_within_the_per_frame_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_root = Path(tmp) / "run-1"
            video_path = run_root / "render" / "final.mp4"
            make_test_video(video_path)

            def write_oversized_frame(_video_path, _timestamp_ms, output_path):
                image = Image.effect_noise((1200, 1200), 100).convert("RGB")
                image.save(output_path, format="JPEG", quality=100, subsampling=0)
                self.assertGreater(output_path.stat().st_size, MAX_FRAME_BYTES)

            with patch("video_factory.review_media._extract_frame", side_effect=write_oversized_frame):
                manifest_path = prepare_review_media(
                    video_path=video_path,
                    run_root=run_root,
                    max_frames=1,
                )

            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            frame_path = run_root / manifest["frames"][0]["path"]
            self.assertLessEqual(frame_path.stat().st_size, MAX_FRAME_BYTES)
            with Image.open(frame_path) as frame:
                frame.verify()

    def test_total_limit_failure_cleans_staging_and_preserves_stable_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_root = Path(tmp) / "run-1"
            video_path = run_root / "render" / "final.mp4"
            make_test_video(video_path)
            stable_manifest_path = prepare_review_media(
                video_path=video_path,
                run_root=run_root,
                max_frames=1,
            )
            stable_manifest_bytes = stable_manifest_path.read_bytes()

            def write_frame(_video_path, _timestamp_ms, output_path):
                Image.new("RGB", (32, 32), "white").save(output_path, format="JPEG", quality=85)

            with patch("video_factory.review_media.MAX_TOTAL_FRAME_BYTES", 1000), patch(
                "video_factory.review_media._extract_frame",
                side_effect=write_frame,
            ):
                with self.assertRaisesRegex(RuntimeError, "bytes in total"):
                    prepare_review_media(
                        video_path=video_path,
                        run_root=run_root,
                        max_frames=2,
                    )

            self.assertEqual(stable_manifest_path.read_bytes(), stable_manifest_bytes)
            self.assertEqual(list(run_root.glob(".review-media-*")), [])

    def test_rejects_a_review_output_symlink_that_escapes_the_run_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            run_root = root / "run-1"
            video_path = run_root / "render" / "final.mp4"
            make_test_video(video_path)
            outside_output = root / "outside-review"
            outside_output.mkdir()
            marker = outside_output / "keep.txt"
            marker.write_text("untouched", encoding="utf-8")
            (run_root / "review_media").symlink_to(outside_output, target_is_directory=True)

            with self.assertRaisesRegex(ValueError, "must stay within run_root"):
                prepare_review_media(video_path=video_path, run_root=run_root)

            self.assertEqual(marker.read_text(encoding="utf-8"), "untouched")
            self.assertEqual(list(run_root.glob(".review-media-*")), [])


def make_test_video(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=320x180:d=1:r=6",
            "-f",
            "lavfi",
            "-i",
            "color=c=white:s=320x180:d=1:r=6",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=320x180:d=1:r=6",
            "-filter_complex",
            "[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p",
            "-c:v",
            "libx264",
            "-movflags",
            "+faststart",
            str(path),
        ],
        check=True,
        capture_output=True,
    )


def make_color_range_video(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "color=c=red:s=160x90:d=2:r=30",
            "-f", "lavfi", "-i", "color=c=green:s=160x90:d=2:r=30",
            "-f", "lavfi", "-i", "color=c=blue:s=160x90:d=2:r=30",
            "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p",
            "-c:v", "libx264", "-g", "180", str(path),
        ],
        check=True,
        capture_output=True,
    )


def make_many_scene_video(path: Path, segment_count: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    for index in range(segment_count):
        color = "black" if index % 2 == 0 else "white"
        command.extend(["-f", "lavfi", "-i", f"color=c={color}:s=160x90:d=1:r=2"])
    inputs = "".join(f"[{index}:v]" for index in range(segment_count))
    command.extend(
        [
            "-filter_complex",
            f"{inputs}concat=n={segment_count}:v=1:a=0,format=yuv420p",
            "-c:v",
            "libx264",
            str(path),
        ]
    )
    subprocess.run(command, check=True, capture_output=True)


def assert_manifest_image(run_root: Path, image_entry: dict) -> None:
    relative_path = Path(image_entry["path"])
    if relative_path.is_absolute() or ".." in relative_path.parts:
        raise AssertionError(f"manifest path is not run-relative: {relative_path}")
    image_path = run_root / relative_path
    content = image_path.read_bytes()
    if hashlib.sha256(content).hexdigest() != image_entry["sha256"]:
        raise AssertionError(f"manifest digest does not match {relative_path}")
    with Image.open(image_path) as image:
        if [image.width, image.height] != [image_entry["width"], image_entry["height"]]:
            raise AssertionError(f"manifest dimensions do not match {relative_path}")


if __name__ == "__main__":
    unittest.main()
