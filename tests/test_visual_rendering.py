import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from video_factory.domain import Scene
from video_factory.renderer import attach_voiceover_plan, font_resource, probe_media_duration, render_asset_video, render_scene_clip, wrap_text_by_pixels as wrap_caption_text, write_caption_overlay, write_scene_frames
from video_factory.stock_assets import local_card_content, local_card_semantic_style, local_card_spec, local_card_style, wrap_text_by_pixels as wrap_card_text


class FixedWidthDraw:
    def textbbox(self, _position, text, font=None, **_kwargs):
        return (0, 0, len(text) * 10, 20)


class VisualRenderingTest(unittest.TestCase):
    def test_voiceover_cannot_rewrite_the_accepted_render_timeline(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            track_path = root / "narration.m4a"
            track_path.write_bytes(b"natural-voice")
            manifest_path = root / "render_manifest.json"
            manifest = {
                "duration_target": 20,
                "slides": [
                    {"position": 1, "duration": 8},
                    {"position": 2, "duration": 12},
                ],
            }
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            voiceover_plan = {
                "track_path": str(track_path),
                "scenes": [
                    {"position": 1, "duration": 8.4},
                    {"position": 2, "duration": 12},
                ],
            }

            with self.assertRaisesRegex(RuntimeError, "accepted render timeline"):
                attach_voiceover_plan(manifest_path, voiceover_plan)

            self.assertEqual(json.loads(manifest_path.read_text(encoding="utf-8")), manifest)

    def test_source_duration_probe_reads_the_video_stream(self):
        with patch("video_factory.renderer.subprocess.run") as run:
            run.return_value = subprocess.CompletedProcess([], 0, "2.000000\n", "")
            self.assertEqual(probe_media_duration(Path("source.mp4")), 2.0)

        command = run.call_args.args[0]
        self.assertEqual(command[command.index("-select_streams") + 1], "v:0")
        self.assertEqual(command[command.index("-show_entries") + 1], "stream=duration")

    def test_font_inventory_does_not_claim_an_unverified_license_is_recorded(self):
        self.assertFalse(font_resource(Path("/fonts/NotoSansCJK-Regular.ttc"))["license_verified"])
        self.assertFalse(font_resource(None)["license_verified"])

    def test_local_card_content_is_derived_from_the_current_scene(self):
        scene = Scene(
            position=2,
            narration="光的方向，决定哪里明，哪里暗。",
            duration=6,
            visual_strategy="local",
            visual_prompt="水杯与侧光示意图",
        )

        title, items, kicker = local_card_content(scene)

        self.assertEqual(title, "光的方向")
        self.assertEqual(items, ["决定哪里明", "哪里暗"])
        self.assertEqual(kicker, "镜头要点")
        self.assertNotIn("避开", " ".join([title, *items, kicker]))

        conclusion = Scene(
            position=4,
            narration="所以，低成本拍氛围，先移动光，再考虑换道具。",
            duration=6,
            visual_strategy="local",
            visual_prompt="总结卡",
        )
        conclusion_title, conclusion_items, _ = local_card_content(conclusion)
        self.assertEqual(conclusion_title, "低成本拍氛围")
        self.assertEqual(conclusion_items, ["先移动光", "再考虑换道具"])

    def test_local_card_palette_keeps_consecutive_cards_visually_cohesive(self):
        backgrounds = {local_card_style(position)["background"] for position in range(1, 8)}

        self.assertTrue(all(int(color[1:3], 16) >= 0xEE for color in backgrounds))

    def test_local_card_spec_rejects_internal_workflow_states_before_building_a_card(self):
        cases = [
            (
                Scene(2, "不能。先让它过证据门禁。", 2.2, "local", "中央为橙色“待证据核验”。"),
                {"query": "minimal evidence verification status card"},
                "verification status flow",
            ),
            (
                Scene(2, "来源未提供。", 2.2, "local", "来源未提供"),
                {"query": "missing source form"},
                "missing-source state",
            ),
            (
                Scene(2, "这条断言还没有核验。", 2.2, "local", "展示断言"),
                {"query": "claim review statement"},
                "claim-review state",
            ),
        ]

        for scene, shot, message in cases:
            with self.subTest(message=message):
                with self.assertRaisesRegex(ValueError, message):
                    local_card_spec(scene, shot)

    def test_local_card_spec_preserves_a_formal_director_checklist(self):
        checklist_scene = Scene(
            position=4,
            narration="三项齐，才进入待发布区。",
            duration=2.2,
            visual_strategy="local",
            visual_prompt="“来源”“原文”“适用范围”三行左对齐，底部保留“待发布”。",
        )
        checklist = local_card_spec(checklist_scene, {
            "query": "minimal three item verification checklist card",
        })
        self.assertEqual(checklist["layout"], "checklist")
        self.assertEqual(checklist["items"], ["来源", "原文", "适用范围"])
        self.assertEqual(checklist["status"], "待发布")
        self.assertEqual(local_card_semantic_style(checklist)["accent"], "#188465")

    def test_internal_workflow_queries_do_not_override_formal_card_content(self):
        scene = Scene(
            position=2,
            narration="光线从左侧推进，杯壁的水珠慢慢变亮。",
            duration=3,
            visual_strategy="local",
            visual_prompt="水杯与侧光的正式解释卡。",
        )

        cards = [
            local_card_spec(scene, {"query": "self review independent red team"}),
            local_card_spec(scene, {"query": "node output self review red team"}),
            local_card_spec(scene, {"query": "paid step user confirmation options"}),
            local_card_spec(scene, {"query": "agent audit payment confirmation outro"}),
        ]

        for card in cards:
            visible_text = " ".join([card["kicker"], card["title"], card["status"], *card["items"]])
            self.assertNotIn("节点审计", visible_text)
            self.assertNotIn("独立红队", visible_text)
            self.assertNotIn("付费节点", visible_text)
            self.assertNotIn("未执行", visible_text)

    def test_generic_typography_direction_does_not_expose_internal_review_language(self):
        scene = Scene(
            position=6,
            narration="延时压缩了光影。记住：影子在走，地球在转。",
            duration=4,
            visual_strategy="local",
            visual_prompt="正式片尾知识结论卡",
        )

        card = local_card_spec(scene, {
            "query": "navy science takeaway typography yellow",
            "visibleAction": "所有文字从首帧完整存在，整张卡片轻微推近。",
        })

        self.assertEqual(card["layout"], "list")
        self.assertNotIn("门禁", " ".join([card["kicker"], card["title"], card["status"]]))
        self.assertNotIn("待证据核验", " ".join([card["kicker"], card["title"], card["status"]]))

    def test_caption_overlay_ignores_project_scene_and_director_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            scene = {"position": 1, "text": "杯壁出现水珠。", "visual_prompt": "叠加“湿空气”“低于露点”"}
            for style in ("subtitle", "editorial"):
                with self.subTest(style=style):
                    first_path = write_caption_overlay(
                        {"title": "内部项目 A", "slides": [scene]},
                        scene,
                        root,
                        360,
                        640,
                        style=style,
                        director_route={
                            "director_shot": {
                                "subject": "Provider AIGC gate",
                                "successCriteria": ["显示“杯壁冷”与 Agent 审片状态"],
                            },
                        },
                    )
                    first_overlay = first_path.read_bytes()
                    second_path = write_caption_overlay(
                        {"title": "另一个项目", "slides": [scene, {"position": 2}]},
                        scene,
                        root,
                        360,
                        640,
                        style=style,
                        director_route={"director_shot": {}},
                    )

                    self.assertEqual(first_overlay, second_path.read_bytes())

    def test_caption_overlay_preserves_main_subtitle_and_first_scene_aigc_disclosure(self):
        from PIL import Image

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = {"title": "不会显示的项目名", "slides": [{}, {}]}
            # 使用所有 CI 字体都能区分的拉丁字符，避免缺少 CJK 字形时两句字幕都渲染成相同方框。
            first_scene = {"position": 1, "text": "Condensation forms."}
            second_scene = {"position": 2, "text": "Condensation forms."}
            changed_subtitle = {"position": 2, "text": "Water comes from air."}

            first_path = write_caption_overlay(manifest, first_scene, root, 360, 640)
            first_image = Image.open(first_path).convert("RGBA")
            second_path = write_caption_overlay(manifest, second_scene, root, 360, 640)
            second_image = Image.open(second_path).convert("RGBA")
            second_overlay = second_path.read_bytes()
            changed_path = write_caption_overlay(manifest, changed_subtitle, root, 360, 640)

            self.assertIsNotNone(first_image.getchannel("A").crop((0, 0, 220, 140)).getbbox())
            self.assertIsNone(second_image.getchannel("A").crop((0, 0, 220, 140)).getbbox())
            self.assertNotEqual(second_overlay, changed_path.read_bytes())

    def test_script_frame_ignores_project_scene_and_director_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "first").mkdir()
            (root / "second").mkdir()
            first_frames = write_scene_frames(
                {
                    "title": "内部项目 A",
                    "slides": [{
                        "position": 2,
                        "duration": 3.0,
                        "text": "杯壁出现水珠。",
                        "visual_strategy": "Provider route",
                        "visual_prompt": "显示 Agent gate 与 AIGC 状态",
                    }],
                },
                root / "first",
                360,
                640,
            )
            second_frames = write_scene_frames(
                {
                    "title": "另一个项目",
                    "slides": [{
                        "position": 8,
                        "duration": 3.0,
                        "text": "杯壁出现水珠。",
                        "visual_strategy": "stock",
                        "visual_prompt": "无文字真实画面",
                    }],
                },
                root / "second",
                360,
                640,
            )

            self.assertEqual(first_frames[0][0].read_bytes(), second_frames[0][0].read_bytes())

    def test_cjk_wrapping_keeps_closing_punctuation_with_the_previous_line(self):
        draw = FixedWidthDraw()

        for wrapper in (wrap_card_text, wrap_caption_text):
            lines = wrapper(draw, "窗边的光。继续移动", object(), 40)
            self.assertTrue(all(not line.startswith("。") for line in lines))
            self.assertIn("窗边的光。", lines)

    def test_image_clips_receive_subtle_motion_but_video_clips_do_not(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            scene = {"position": 1, "duration": 2.0}

            def fake_run(command, check, capture_output, text):
                self.assertTrue(check)
                if command[0] == "ffprobe":
                    return subprocess.CompletedProcess(command, 0, "2.000000\n", "")
                return subprocess.CompletedProcess(command, 0, "", "")

            with patch("video_factory.renderer.subprocess.run", side_effect=fake_run):
                _, image_command = render_scene_clip(
                    scene,
                    {"provider": "local", "media_type": "image", "local_path": str(root / "card.png")},
                    root / "caption.png",
                    root,
                    1080,
                    1920,
                )
                _, video_command = render_scene_clip(
                    scene,
                    {"media_type": "video", "local_path": str(root / "clip.mp4")},
                    root / "caption.png",
                    root,
                    1080,
                    1920,
                )

        image_filter = image_command[image_command.index("-filter_complex") + 1]
        self.assertEqual(image_command[image_command.index("-framerate") + 1], "30")
        self.assertIn("zoompan", image_filter)
        self.assertNotIn("fade=t=in", image_filter)
        self.assertNotIn("enable='lt(t,1.35)'", image_filter)
        self.assertNotIn("enable='lt(t,2.85)'", image_filter)
        self.assertNotIn("zoompan", video_command[video_command.index("-filter_complex") + 1])

    def test_generated_video_clips_keep_normal_speed_and_use_only_the_planned_range(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            scene = {"position": 1, "duration": 3.0}

            def fake_run(command, check, capture_output, text):
                self.assertTrue(check)
                if command[0] == "ffprobe":
                    return subprocess.CompletedProcess(command, 0, "5.875\n", "")
                return subprocess.CompletedProcess(command, 0, "", "")

            with patch("video_factory.renderer.subprocess.run", side_effect=fake_run):
                _, command = render_scene_clip(
                    scene,
                    {
                        "provider": "hailuo-video-v1",
                        "media_type": "video",
                        "local_path": str(root / "generated.mp4"),
                    },
                    root / "caption.png",
                    root,
                    1080,
                    1920,
                )

        video_filter = command[command.index("-filter_complex") + 1]
        self.assertNotIn("-stream_loop", command)
        self.assertIn("trim=start=0.000000000:end=3.000000000", video_filter)
        self.assertIn("setpts=PTS-STARTPTS,fps=30", video_filter)
        self.assertNotIn("*PTS", video_filter)
        self.assertNotIn("tpad=", video_filter)

    def test_explicit_invalid_compiled_frame_count_is_rejected_instead_of_using_scene_duration(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for invalid in (0, -1, 1.5, True, "90"):
                with self.subTest(duration_frames=invalid):
                    with self.assertRaisesRegex(RuntimeError, "invalid compiled frame count"):
                        render_scene_clip(
                            {"position": 1, "duration": 3.0},
                            {
                                "media_type": "image",
                                "local_path": str(root / "card.png"),
                                "duration_frames": invalid,
                            },
                            root / "caption.png",
                            root,
                            1080,
                            1920,
                        )

    def test_rejects_an_image_source_offset_and_a_video_range_past_the_source_end(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertRaisesRegex(RuntimeError, "source frame offset to an image"):
                render_scene_clip(
                    {"position": 1, "duration": 1.0},
                    {
                        "media_type": "image",
                        "local_path": str(root / "card.png"),
                        "duration_frames": 30,
                        "source_in_frame": 1,
                    },
                    root / "caption.png",
                    root,
                    1080,
                    1920,
                    frame_count=30,
                )
            with patch("video_factory.renderer.probe_media_duration", return_value=2.0):
                with self.assertRaisesRegex(RuntimeError, "selected video ends"):
                    render_scene_clip(
                        {"position": 2, "duration": 1.0},
                        {
                            "media_type": "video",
                            "local_path": str(root / "short.mp4"),
                            "duration_frames": 31,
                            "source_in_frame": 30,
                        },
                        root / "caption.png",
                        root,
                        1080,
                        1920,
                        frame_count=31,
                    )

    def test_accepts_a_video_range_that_ends_exactly_at_the_source_tail(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch("video_factory.renderer.probe_media_duration", return_value=2.0), patch(
                "video_factory.renderer.subprocess.run",
                return_value=subprocess.CompletedProcess([], 0, "", ""),
            ):
                _, command = render_scene_clip(
                    {"position": 1, "duration": 1.0},
                    {
                        "media_type": "video",
                        "local_path": str(root / "exact-tail.mp4"),
                        "duration_frames": 30,
                        "source_in_frame": 30,
                    },
                    root / "caption.png",
                    root,
                    1080,
                    1920,
                    frame_count=30,
                )

        video_filter = command[command.index("-filter_complex") + 1]
        self.assertIn("trim=start=1.000000000:end=2.000000000", video_filter)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg is required")
    def test_vfr_video_is_sampled_at_30fps_without_retiming_the_selected_range(self):
        from PIL import Image

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_path = root / "vfr.mp4"
            subprocess.run([
                "ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc2=s=90x160:r=30:d=2",
                "-vf", "setpts='if(lt(N,30),N/(15*TB),(2+(N-30)/60)/TB)'",
                "-fps_mode", "vfr", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(source_path),
            ], check=True, capture_output=True)
            caption_path = root / "caption.png"
            Image.new("RGBA", (90, 160), (0, 0, 0, 0)).save(caption_path)

            clip_path, command = render_scene_clip(
                {"position": 1, "duration": 2},
                {
                    "media_type": "video",
                    "local_path": str(source_path),
                    "duration_frames": 60,
                    "source_in_frame": 0,
                },
                caption_path,
                root,
                90,
                160,
                frame_count=60,
            )
            probe = subprocess.run([
                "ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
                "-show_entries", "stream=nb_read_frames", "-of", "default=nw=1:nk=1", str(clip_path),
            ], check=True, capture_output=True, text=True)

        self.assertEqual(probe.stdout.strip(), "60")
        video_filter = command[command.index("-filter_complex") + 1]
        self.assertIn("setpts=PTS-STARTPTS,fps=30", video_filter)
        self.assertNotIn("*PTS", video_filter)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg is required")
    def test_video_clip_uses_the_compiled_source_range_without_looping_or_retiming(self):
        from PIL import Image

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_path = root / "red-green-blue.mp4"
            subprocess.run([
                "ffmpeg", "-y",
                "-f", "lavfi", "-i", "color=c=red:s=90x160:r=30:d=4",
                "-f", "lavfi", "-i", "color=c=green:s=90x160:r=30:d=4",
                "-f", "lavfi", "-i", "color=c=blue:s=90x160:r=30:d=4",
                "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
                "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(source_path),
            ], check=True, capture_output=True)
            caption_path = root / "caption.png"
            Image.new("RGBA", (90, 160), (0, 0, 0, 0)).save(caption_path)

            clip_path, command = render_scene_clip(
                {"position": 1, "duration": 4},
                {
                    "provider": "pexels",
                    "media_type": "video",
                    "local_path": str(source_path),
                    "duration_frames": 120,
                    "source_in_frame": 120,
                },
                caption_path,
                root,
                90,
                160,
                frame_count=120,
            )
            probe = subprocess.run([
                "ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0",
                "-show_entries", "stream=nb_read_frames", "-of", "default=nw=1:nk=1", str(clip_path),
            ], check=True, capture_output=True, text=True)
            colors = []
            for index, timestamp in enumerate((0.1, 3.9)):
                frame_path = root / f"sample-{index}.png"
                subprocess.run([
                    "ffmpeg", "-y", "-ss", str(timestamp), "-i", str(clip_path),
                    "-frames:v", "1", str(frame_path),
                ], check=True, capture_output=True)
                colors.append(Image.open(frame_path).convert("RGB").getpixel((45, 80)))

        self.assertEqual(probe.stdout.strip(), "120")
        self.assertNotIn("-stream_loop", command)
        self.assertNotIn("tpad=", command[command.index("-filter_complex") + 1])
        for red, green, blue in colors:
            self.assertGreater(green, red * 2)
            self.assertGreater(green, blue * 2)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg is required")
    def test_24_second_render_contains_exactly_720_video_frames(self):
        from PIL import Image

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            asset_path = root / "asset.png"
            Image.new("RGB", (180, 320), "#334155").save(asset_path)
            manifest_path = root / "render_manifest.json"
            durations = [3.01] * 7 + [2.93]
            slides = [
                {
                    "position": position,
                    "duration": duration,
                    "text": f"第 {position} 个镜头。",
                    "visual_prompt": "无文字真实画面",
                }
                for position, duration in enumerate(durations, start=1)
            ]
            manifest_path.write_text(
                json.dumps({"title": "精确时长", "slides": slides, "output_file": str(root / "final.mp4")}),
                encoding="utf-8",
            )
            asset_plan = {
                "scene_assets": [
                    {
                        "scene_position": position,
                        "provider": "pexels",
                        "media_type": "image",
                        "local_path": str(asset_path),
                    }
                    for position in range(1, 9)
                ]
            }

            output_path = render_asset_video(manifest_path, root, asset_plan, resolution="180x320")
            result = subprocess.run(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-count_frames",
                    "-select_streams",
                    "v:0",
                    "-show_entries",
                    "stream=duration,nb_frames,nb_read_frames",
                    "-of",
                    "json",
                    str(output_path),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            stream = json.loads(result.stdout)["streams"][0]

        self.assertEqual(stream["duration"], "24.000000")
        self.assertEqual(stream["nb_frames"], "720")
        self.assertEqual(stream["nb_read_frames"], "720")


if __name__ == "__main__":
    unittest.main()
