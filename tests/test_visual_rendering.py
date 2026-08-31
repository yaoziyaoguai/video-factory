import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from video_factory.domain import Scene
from video_factory.renderer import director_overlay_labels, font_resource, render_scene_clip, wrap_text_by_pixels as wrap_caption_text
from video_factory.stock_assets import local_card_content, local_card_semantic_style, local_card_spec, local_card_style, wrap_text_by_pixels as wrap_card_text


class FixedWidthDraw:
    def textbbox(self, _position, text, font=None, **_kwargs):
        return (0, 0, len(text) * 10, 20)


class VisualRenderingTest(unittest.TestCase):
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

    def test_local_card_spec_preserves_the_director_semantics_instead_of_using_one_generic_card(self):
        status_scene = Scene(
            position=2,
            narration="不能。先让它过证据门禁。",
            duration=2.2,
            visual_strategy="local",
            visual_prompt="上方灰色小标签“生成完成”，中央为橙色“待证据核验”。",
        )
        status = local_card_spec(status_scene, {
            "query": "minimal evidence verification status card",
            "successCriteria": ["首帧即可读到“生成完成 → 待证据核验”的完整关系。"],
        })
        self.assertEqual(status["layout"], "status_flow")
        self.assertEqual(status["items"], ["生成完成", "待证据核验"])

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
        self.assertEqual(local_card_semantic_style(status)["accent"], "#d97706")
        self.assertEqual(local_card_semantic_style(checklist)["accent"], "#188465")

    def test_local_card_spec_supports_audit_paid_gate_and_outro_visual_grammar(self):
        scene = Scene(
            position=2,
            narration="先自审，再交独立红队。",
            duration=3,
            visual_strategy="local",
            visual_prompt="蓝色自审、红色独立红队。",
        )

        audit = local_card_spec(scene, {"query": "self review independent red team"})
        node_audit = local_card_spec(scene, {"query": "node output self review red team"})
        paid = local_card_spec(scene, {"query": "paid step user confirmation options"})
        outro = local_card_spec(scene, {"query": "agent audit payment confirmation outro"})

        self.assertEqual(audit["layout"], "audit_flow")
        self.assertEqual(audit["items"], ["自审", "独立红队"])
        self.assertEqual(node_audit["items"], ["节点输出", "自审", "独立红队"])
        self.assertEqual(paid["layout"], "paid_gate")
        self.assertEqual(paid["items"], ["返回修改", "确认继续"])
        self.assertIn("未执行", paid["status"])
        self.assertEqual(outro["layout"], "audit_outro")
        self.assertEqual(outro["title"], "每个节点：自审 → 红队")
        self.assertEqual(local_card_semantic_style(audit)["background"], "#0b1220")

    def test_stock_overlay_uses_only_director_requested_visible_labels(self):
        manifest = {
            "slides": [
                {"visual_prompt": "三行标签“来源”“原文”“适用范围”"},
                {"visual_prompt": "补上“来源”“原文”“适用范围”"},
            ],
        }
        scene = {"visual_prompt": "手机上方叠加已完成的三项核验条"}
        route = {"director_shot": {"successCriteria": ["点击前有完整三项完成状态叠加区。"]}}

        self.assertEqual(director_overlay_labels(manifest, scene, route), ["来源 · 已完成", "原文 · 已完成", "适用范围 · 已完成"])

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

    def test_generated_video_clips_fit_the_complete_source_motion_into_the_scene(self):
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
        self.assertIn("setpts=0.510638*PTS", video_filter)


if __name__ == "__main__":
    unittest.main()
