import shutil
import hashlib
import json
import io
from contextlib import redirect_stdout
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from video_factory.domain import Scene, StockAssetCandidate
from dataclasses import asdict, replace
from video_factory.stock_assets import materialize_first_candidate, prepare_routed_scene_assets, prepare_scene_assets
from video_factory.review_media import main as review_media_main


def candidate(asset_id, duration):
    return StockAssetCandidate(
        provider="pexels", asset_id=asset_id, media_type="video", width=720, height=1280,
        duration=duration, preview_url="", download_url=f"https://videos.pexels.com/{asset_id}.mp4",
        source_url=f"https://www.pexels.com/video/{asset_id}/", creator="Test", license_note="Test",
        query="sea", score=80,
    )


def make_video(target, duration):
    subprocess.run([
        "ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "color=blue:s=720x1280:r=25",
        "-t", str(duration), "-an", "-c:v", "libx264", "-preset", "ultrafast", str(target),
    ], check=True, capture_output=True, timeout=30)


class StockDurationTest(unittest.TestCase):
    def test_real_preprocessor_returns_structured_short_range_before_sampling(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "private-source.mp4"
            make_video(source, 7.84)
            plan = root / "asset_plan.json"
            plan.write_text(json.dumps({"scene_assets": [{"scene_position": 3, "duration_frames": 240,
                "source_in_frame": 0, "media_type": "video", "local_path": str(source)}]}))
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                code = review_media_main(["--asset-plan", str(plan), "--run-root", str(root)])
            self.assertEqual(code, 2)
            self.assertEqual(json.loads(stdout.getvalue()), {"version": "video-factory/review-media-error-v1",
                "code": "SOURCE_RANGE_TOO_SHORT", "scenePositions": [3]})
            self.assertFalse((root / "asset_review_media").exists())

    def test_single_provider_path_rejects_a_short_video_too(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch("video_factory.stock_assets.search_stock_assets", return_value=[candidate("short", 7)]), \
                 patch("video_factory.stock_assets.materialize_candidate") as download:
                with self.assertRaisesRegex(RuntimeError, "时长"):
                    prepare_scene_assets(1, [Scene(1, "海", 8, "stock", "sea")], Path(tmp), "pexels")
            download.assert_not_called()

    def test_routed_recovery_reuses_two_compatible_files_and_only_downloads_replacement(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            long = root / "long.mp4"
            short = root / "short.mp4"
            make_video(long, 10)
            make_video(short, 7.84)
            scenes = [Scene(position, "看看海", 8, "stock", "sea") for position in [1, 2, 3]]
            inventory = {"version": "video-factory/asset-candidate-inventory-v1", "scene_candidates": []}
            routes = {"shots": []}
            reusable = []
            for position in [1, 2, 3]:
                old = candidate(f"old-{position}", 10 if position < 3 else 8)
                if position == 2:
                    old = replace(old, provider="pixabay")
                inventory["scene_candidates"].append({"scene_position": position, "candidates": [
                    {**asdict(item), "provider_id": f"{item.provider}-stock-v1"} for item in [old, candidate(f"new-{position}", 10)]
                ]})
                routes["shots"].append({"scenePosition": position, "preferredProviderId": "pexels-stock-v1",
                                         "alternativeProviderIds": ["pixabay-stock-v1"], "query": "sea", "deliveryType": "stock_video"})
                source = long if position < 3 else short
                reusable.append({"scenePosition": position, "provider": old.provider, "assetId": old.asset_id,
                                 "localPath": str(source), "sha256": hashlib.sha256(source.read_bytes()).hexdigest()})
            downloaded = []

            def download(item, target):
                downloaded.append(item.asset_id)
                shutil.copyfile(long, target)
                return target

            with patch("video_factory.stock_assets.materialize_candidate", side_effect=download):
                plan_path = prepare_routed_scene_assets(1, scenes, root / "retry", routes,
                    candidate_inventory=inventory, reusable_assets=reusable,
                    required_source_ends={1: 8, 2: 10, 3: 8})
            plan = json.loads(plan_path.read_text())
            self.assertEqual(downloaded, ["new-3"])
            self.assertEqual([item["asset_id"] for item in plan["scene_assets"]], ["old-1", "old-2", "new-3"])
            self.assertEqual(short.stat().st_size > 0, True)
            for item in plan["scene_assets"][:2]:
                self.assertEqual(Path(item["local_path"]).read_bytes(), long.read_bytes())

    def test_source_offset_is_included_and_unknown_metadata_is_probed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "master.mp4"
            make_video(source, 9)

            def download(_item, target):
                shutil.copyfile(source, target)
                return target

            with patch("video_factory.stock_assets.materialize_candidate", side_effect=download):
                scene = Scene(1, "海", 8, "stock", "sea")
                self.assertIsNone(materialize_first_candidate(scene, [candidate("unknown", 0)], root,
                                                             required_source_end=10))
                accepted = materialize_first_candidate(scene, [candidate("unknown", 0)], root,
                                                       required_source_end=9)
            self.assertEqual(accepted.duration, 8)
            self.assertEqual(accepted.source_duration, 9)

    def test_actual_short_video_is_rejected_even_when_metadata_claims_eight_seconds(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "actual-7.84.mp4"
            make_video(source, 7.84)
            released = []
            notes = []

            def download(_item, target):
                shutil.copyfile(source, target)
                return target

            with patch("video_factory.stock_assets.materialize_candidate", side_effect=download):
                result = materialize_first_candidate(
                    Scene(3, "看看海", 8, "stock", "sea"), [candidate("rounded-up", 8)], root,
                    claim=lambda _item: True, release=lambda item: released.append(item.asset_id), failures=notes,
                )
            self.assertIsNone(result)
            self.assertEqual(released, ["rounded-up"])
            self.assertTrue(any("7.84" in note and "8" in note for note in notes))

    def test_known_short_stock_is_skipped_before_download(self):
        scene = Scene(3, "看看海", 8, "stock", "sea")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "long.mp4"
            make_video(source, 9)
            downloaded = []

            def download(item, target):
                downloaded.append(item.asset_id)
                shutil.copyfile(source, target)
                return target

            notes = []
            with patch("video_factory.stock_assets.materialize_candidate", side_effect=download):
                result = materialize_first_candidate(scene, [candidate("short", 7), candidate("long", 9)], root,
                                                     failures=notes)
            self.assertEqual(downloaded, ["long"])
            self.assertEqual(result.asset_id, "long")
            self.assertTrue(any("short" in note and "时长" in note for note in notes))
