import copy
import hashlib
import io
import os
import sys
import json
import tempfile
import unittest
import wave
import subprocess
from pathlib import Path
from unittest.mock import patch

from video_factory.character_narration_plan import build_character_narration_plan
from video_factory.materialized_voice_source import read_materialized_manifest
from video_factory.narration_subtitles import build_group_subtitles
from video_factory.worker import handle_request
from video_factory.renderer import write_render_manifest, attach_voiceover_plan, render_script_video, render_audio_duration_options
from test_character_voiceover import SCRIPT, materialize
from test_continuous_voice_worker import voice_request
from test_continuous_voiceover import tone


def character_request(root):
    request = voice_request(root)
    script = copy.deepcopy(SCRIPT)
    Path(request["input"]["scriptPath"]).write_text(json.dumps(script, ensure_ascii=False))
    visual_path = Path(request["input"]["executablePlanPath"])
    visual = json.loads(visual_path.read_text())
    visual.update({"totalFrames": 720, "durationRange": {"minSeconds": 24, "maxSeconds": 24},
        "cuts": [{"scenePosition": i + 1, "startFrame": i * 180, "frameCount": 180,
                  "sourceInFrame": 0, "assetKey": f"scene-{i + 1}"} for i in range(4)]})
    visual_path.write_text(json.dumps(visual))
    plan = build_character_narration_plan({"script": script,
        "scriptSha256": hashlib.sha256(Path(request["input"]["scriptPath"]).read_bytes()).hexdigest(),
        "visualSha256": hashlib.sha256(visual_path.read_bytes()).hexdigest(), "sourceContextId": "character-worker"})
    Path(request["input"]["narrationPlanPath"]).write_text(json.dumps(plan))
    request["input"]["voiceInputIdentity"] = {"voiceInputVersionId": "voice-input-1", "sourceContextId": "character-worker",
        "scriptArtifactId": "script-1", "scriptOutputVersionId": "script-version-1",
        "visualArtifactId": "visual-1", "visualOutputVersionId": "visual-version-1",
        "parentArtifactIds": ["script-1", "visual-1"], "upstreamVersionIds": ["script-version-1", "visual-version-1"]}
    return request, plan


class CharacterVoiceWorkerTests(unittest.TestCase):
    def test_manifest_crashes_recover_locally_and_reject_changed_sources(self):
        child_source = r"""
import os, sys, json
from pathlib import Path
from unittest.mock import patch
from test_character_voiceover import materialize
import video_factory.worker as worker
request = json.load(sys.stdin)
root = Path(request["outputDir"]).parent
write_manifest = worker.write_materialized_manifest
def send(http_request, audio, metadata_path=None, response_binding=None):
    with (root / "submits.jsonl").open("a") as log:
        log.write(json.dumps(response_binding) + "\n")
    materialize(audio, metadata_path, response_binding)
def crash(manifest, output_dir):
    if sys.argv[1] == "after":
        write_manifest(manifest, output_dir)
    os._exit(87)
with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=send), \
     patch.object(worker, "write_materialized_manifest", side_effect=crash):
    worker.handle_request(request)
raise AssertionError("crash boundary was not reached")
"""
        for boundary in ("before", "after"):
            with self.subTest(boundary=boundary), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                request, plan = character_request(root)
                repo = Path(__file__).resolve().parents[1]
                child = subprocess.run([sys.executable, "-c", child_source, boundary],
                    input=json.dumps(request), capture_output=True, text=True, timeout=30,
                    env={"PATH": os.environ["PATH"], "PYTHONPATH": str(repo / "src") + os.pathsep + str(repo / "tests"),
                         "MINIMAX_API_KEY": "test-key", "NO_PROXY": "127.0.0.1,localhost"})
                self.assertEqual(child.returncode, 87, child.stderr)
                calls = (root / "voice" / "submits.jsonl").read_bytes()
                self.assertEqual(len(calls.splitlines()), 8)
                manifest_path = Path(request["outputDir"]) / "materialized_voice_source.json"
                self.assertEqual(manifest_path.exists(), boundary == "after")
                recovery = {**request, "commandId": "recover-manifest", "attempt": 2,
                    "outputDir": str(root / "voice" / "recovery"),
                    "input": {**request["input"], "rebuild_manifest": True,
                        "sourceOperationId": request["commandId"],
                        **({"manifestPath": str(manifest_path)} if boundary == "after" else {})}}
                with patch("video_factory.worker.synthesize_minimax_groups", side_effect=AssertionError("no synthesis")):
                    recovered = handle_request(recovery)
                self.assertEqual(recovered["status"], "succeeded", recovered)
                self.assertEqual(recovered["diagnostics"]["externalSendCount"], 0)
                self.assertEqual(recovered["output"]["recovered"], "verified" if boundary == "after" else "rebuilt")
                recovered_path = Path(recovered["output"]["manifestPath"])
                original = recovered_path.read_bytes()
                manifest = read_materialized_manifest(recovered_path, root / "voice")
                self.assertEqual([g["turnId"] for g in manifest["groups"]], [g["turnId"] for g in plan["groups"]])
                # 负例走正式归档恢复消费者，不只断言 JSON parser。
                for changed in ("run", "speaker", "voice", "script", "path", "symlink", "audio"):
                    with self.subTest(changed=changed):
                        invalid = copy.deepcopy(manifest)
                        raw = root / "voice" / manifest["groups"][0]["raw"]["relativePath"]
                        raw_bytes = raw.read_bytes()
                        if changed == "run":
                            invalid["runId"] = "another-run"
                        elif changed in ("speaker", "voice"):
                            invalid["groups"][0]["speakerId" if changed == "speaker" else "voiceProfileId"] = "different"
                        elif changed == "script":
                            invalid["script"]["sha256"] = "f" * 64
                        elif changed == "path":
                            invalid["groups"][0]["raw"]["relativePath"] = "../../outside.mp3"
                        elif changed == "symlink":
                            outside = root / "outside.mp3"
                            outside.write_bytes(raw_bytes)
                            raw.unlink()
                            raw.symlink_to(outside)
                        elif changed == "audio":
                            raw.write_bytes(b"changed audio")
                        body = {k: v for k, v in invalid.items() if k != "manifestSha256"}
                        invalid["manifestSha256"] = hashlib.sha256(json.dumps(body, ensure_ascii=False,
                            sort_keys=True, separators=(",", ":")).encode()).hexdigest()
                        recovered_path.write_text(json.dumps(invalid))
                        attempt = {**recovery, "input": {**recovery["input"], "manifestPath": str(recovered_path)}}
                        try:
                            with patch("video_factory.worker.synthesize_minimax_groups", side_effect=AssertionError("no synthesis")), \
                                    self.assertRaisesRegex(ValueError, "不属于|不一致|越出"):
                                handle_request(attempt)
                        finally:
                            if raw.is_symlink():
                                raw.unlink()
                            raw.write_bytes(raw_bytes)
                            recovered_path.write_bytes(original)
                self.assertEqual((root / "voice" / "submits.jsonl").read_bytes(), calls)

    def test_worker_materializes_v2_manifest_v4_track_and_speaker_bound_subtitles(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request, plan = character_request(root)
            texts = iter(g["text"] for g in plan["groups"])
            def send(http_request, audio, metadata_path=None, response_binding=None):
                materialize(audio, metadata_path, response_binding)
                response = json.loads(metadata_path.read_text())
                response["subtitle_file"] = "https://test.invalid/subtitles/" + response_binding["itemRequestId"]
                metadata_path.write_text(json.dumps(response))
            def subtitles(*args, **kwargs):
                return io.BytesIO(json.dumps([{"text": next(texts), "time_begin": 0, "time_end": 300}]).encode())
            with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=send) as provider, \
                    patch("video_factory.narration_subtitles.open_asset_request", side_effect=subtitles), \
                    patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}):
                result = handle_request(request)
            self.assertEqual(result["status"], "succeeded", result)
            self.assertEqual(provider.call_count, 8)
            output = json.loads(Path(result["output"]["voiceoverPlanPath"]).read_text())
            self.assertEqual(output["version"], "video-factory/voiceover-plan-v4")
            self.assertEqual(output["subtitles"]["status"], "verified")
            with wave.open(output["pcm_path"]) as audio:
                self.assertEqual(audio.getnframes(), 720 * 1470)
            manifest_artifact = next(a for a in result["artifacts"] if a["kind"] == "voice_source_manifest")
            manifest = read_materialized_manifest(Path(manifest_artifact["uri"]), root / "voice")
            self.assertEqual(manifest["version"], "video-factory/voice-source-manifest-v2")
            for group, entry, cue in zip(plan["groups"], manifest["groups"], output["subtitles"]["cues"]):
                for key in ("turnId", "speakerId", "voiceProfileId"):
                    self.assertEqual(entry[key], group[key])
                self.assertEqual(entry["providerId"], "minimax-tts-v1")
                self.assertEqual(entry["modelId"], "speech-2.8-turbo")
                self.assertEqual(cue["turnId"], group["turnId"])
                self.assertEqual(cue["speakerId"], group["speakerId"])
                self.assertEqual(cue["text"], group["text"])
            self.assertNotIn("voice", manifest["synthesis"], "不能声称全片只有一种声音")
            # 新版字幕证据被篡改或换成根外符号链接时，不冒充verified，也不重新下载/购买。
            evidence = next(p for p in (root / "voice" / ".subtitle-evidence").glob("*.json")
                if not p.name.endswith(".receipt.json"))
            evidence_bytes = evidence.read_bytes()
            ledger = root / "voice" / manifest["ledger"]["snapshot"]["relativePath"]
            for tamper in ("content", "symlink"):
                with self.subTest(subtitle_tamper=tamper):
                    if tamper == "content":
                        evidence.write_text("[]")
                    else:
                        outside = root / "outside-subtitle.json"
                        outside.write_bytes(evidence_bytes)
                        evidence.unlink()
                        evidence.symlink_to(outside)
                    try:
                        with patch("video_factory.narration_subtitles.open_asset_request", side_effect=AssertionError("不能重取")):
                            checked = build_group_subtitles(ledger, root / "voice", output,
                                narration_plan_sha256=output["subtitles"]["acceptedNarrationPlanSha256"],
                                adapter_version=output["subtitles"]["adapterVersion"], allow_initial_download=False)
                        self.assertNotEqual(checked["status"], "verified")
                        self.assertEqual(checked["cues"], [])
                    finally:
                        if evidence.is_symlink():
                            evidence.unlink()
                        evidence.write_bytes(evidence_bytes)
            # 用实际总音轨走正式 renderer，不以假 MP4 或整镜台词字幕替代角色成片。
            script_path = Path(request["input"]["scriptPath"])
            script = json.loads(script_path.read_text())
            script.update({"title": "四个人找钥匙", "duration_target": 24})
            script_path.write_text(json.dumps(script, ensure_ascii=False))
            render_root = root / "render"
            render_manifest = write_render_manifest(1, script_path, render_root, "160x284")
            with self.assertRaises(RuntimeError):
                attach_voiceover_plan(render_manifest, {**output, "version": "video-factory/voiceover-plan-v3"})
            invalid = copy.deepcopy(output)
            invalid["groups"][0]["speakerId"] = "courier"
            with self.assertRaises(RuntimeError):
                attach_voiceover_plan(render_manifest, invalid)
            attach_voiceover_plan(render_manifest, output)
            rendered = json.loads(render_manifest.read_text())
            self.assertTrue(all(not slide["text"] for slide in rendered["slides"]))
            self.assertEqual(render_audio_duration_options(rendered), ["-t", "24.000000000"])
            video = render_script_video(render_manifest, render_root, "160x284")
            probe = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(video)]))
            self.assertEqual([s["codec_type"] for s in probe["streams"]], ["video", "audio"])
            subprocess.run(["ffmpeg", "-v", "error", "-i", str(video), "-f", "null", "-"], check=True, capture_output=True)

    def test_first_fit_conflict_has_durable_sources_and_recovers_by_local_turn_layout(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request, plan = character_request(root)
            sent = []
            subtitle_responses = {}
            def send(http_request, audio, metadata_path=None, response_binding=None):
                sent.append(json.loads(http_request.data))
                seconds = 4 if len(sent) == 1 else 0.35
                tone(audio, seconds)
                subtitle_url = "https://test.invalid/subtitles/" + response_binding["itemRequestId"]
                subtitle_responses[subtitle_url] = [{"text": sent[-1]["text"], "time_begin": 0,
                                                     "time_end": round(seconds * 1000)}]
                metadata_path.write_text(json.dumps({"request": response_binding,
                    "audio_sha256": hashlib.sha256(audio.read_bytes()).hexdigest(), "audio_size_bytes": audio.stat().st_size,
                    "subtitle_file": subtitle_url}))
            def subtitles(http_request, **kwargs):
                return io.BytesIO(json.dumps(subtitle_responses[http_request.full_url]).encode())
            with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=send), \
                    patch("video_factory.narration_subtitles.open_asset_request", side_effect=subtitles) as subtitle_download, \
                    patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}):
                result = handle_request(request)
            self.assertEqual(result["status"], "rejected", result)
            conflict = result["output"]["conflict"]
            self.assertEqual(conflict["version"], "video-factory/narration-fit-conflict-v3")
            self.assertEqual(conflict["turnId"], plan["groups"][0]["turnId"])
            self.assertEqual(conflict["speakerId"], plan["groups"][0]["speakerId"])
            manifest_path = Path(next(a for a in result["artifacts"] if a["kind"] == "voice_source_manifest")["uri"])
            before = manifest_path.read_bytes()
            groups = [{"groupId": g["id"], "window": g["window"], "placement": g["placement"]} for g in plan["groups"]]
            groups[0]["window"] = {"startFrame": 0, "endFrame": 130}
            groups[1]["window"] = {"startFrame": 133, "endFrame": 180}
            relayout = {**request, "commandId": "local-layout", "attempt": 2, "outputDir": str(root / "voice" / "local-layout"),
                "input": {**request["input"], "relayout": True, "manifestPath": str(manifest_path),
                    "sourceOperationId": request["commandId"], "relayoutSource": "materialized_operation",
                    "sourceIdentity": {**request["input"]["voiceInputIdentity"], "narrationPlanPath": request["input"]["narrationPlanPath"]},
                    "sourceManifestIdentity": {"artifactId": "manifest-1", "sha256": hashlib.sha256(before).hexdigest()},
                    "relayoutReservation": {"requestDigest": "d" * 64, "commandId": "local-layout", "attempt": 2,
                        "layoutOperationId": "relayout-local-layout", "reservedInputVersionId": "input-layout",
                        "reservedOutputVersionId": "output-layout", "workerExecutionToken": "worker-layout"},
                    "layout": {"narrationPlanVersion": plan["version"], "groups": groups, "userSilences": []}},
                "parameters": {"provider": "minimax", "maxCostCny": 0}}
            with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=AssertionError("不能再次购买")), \
                    patch("video_factory.narration_subtitles.open_asset_request", side_effect=AssertionError("排轨不能外发")):
                recovered = handle_request(relayout)
            self.assertEqual(recovered["status"], "succeeded", recovered)
            self.assertEqual(recovered["diagnostics"]["externalSendCount"], 0)
            self.assertEqual(len(sent), 8)
            self.assertEqual(manifest_path.read_bytes(), before)
            completion = json.loads(Path(recovered["output"]["completionReceiptPath"]).read_text())
            self.assertEqual(completion["version"], "video-factory/narration-relayout-completion-v2")
            output = json.loads(Path(recovered["output"]["voiceoverPlanPath"]).read_text())
            self.assertEqual(output["version"], "video-factory/voiceover-plan-v4")
            self.assertEqual(output["groups"][1]["startSample"], 133 * 1470)
            self.assertEqual(output["groups"][0]["sourceAudioSamples"], 4 * 44100)
            self.assertEqual(output["subtitles"]["status"], "verified",
                "首次排轨冲突不能跳过原字幕保存，否则零外发时间调整会丢字幕")
            self.assertEqual(subtitle_download.call_count, 8)
            self.assertEqual([cue["text"] for cue in output["subtitles"]["cues"]],
                             [group["text"] for group in plan["groups"]])
            self.assertEqual(output["subtitles"]["cues"][1]["startSample"], 133 * 1470)
