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
    prepare_review_media,
)


FFMPEG_AVAILABLE = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


@unittest.skipUnless(FFMPEG_AVAILABLE, "FFmpeg and ffprobe are required")
class ReviewMediaTest(unittest.TestCase):
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
            self.assertGreater(manifest["durationMs"], 0)
            self.assertGreaterEqual(len(manifest["frames"]), 3)
            self.assertLessEqual(len(manifest["frames"]), 12)
            self.assertNotIn(str(run_root), first_manifest_bytes.decode("utf-8"))

            timestamps = [frame["timestampMs"] for frame in manifest["frames"]]
            self.assertEqual(timestamps, sorted(set(timestamps)))
            for frame in manifest["frames"]:
                self.assertEqual(set(frame), {"path", "timestampMs", "sha256", "width", "height"})
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
