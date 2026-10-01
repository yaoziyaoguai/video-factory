import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from video_factory.narration_plan import build_narration_plan, build_narration_plan_v2
from video_factory.materialized_voice_source import build_materialized_manifest, read_materialized_manifest
from video_factory.worker import handle_request
import video_factory.worker as worker_module
from test_continuous_voiceover import tone


def voice_request(root: Path, operation: str = "group-operation") -> dict:
    scenes = [{"position": position, "duration": duration, "narration": text}
              for position, duration, text in ((1, 6, "先看见，"), (2, 6, "再停下，"), (3, 8, "然后出发。"))]
    script = root / "script.json"
    visual = root / "visual.json"
    script.write_text(json.dumps({"duration_target": 20, "scenes": scenes}, ensure_ascii=False))
    visual.write_text(json.dumps({"version": "video-factory/executable-plan-v1", "fps": 30,
        "totalFrames": 600, "durationRange": {"minSeconds": 20, "maxSeconds": 20},
        "cuts": [{"scenePosition": index + 1, "startFrame": start, "frameCount": count,
                  "sourceInFrame": 0, "assetKey": f"scene-{index + 1}"}
                 for index, (start, count) in enumerate(((0, 180), (180, 180), (360, 240)))]}))
    narration = root / "voice" / "narration.json"
    narration.parent.mkdir(parents=True, exist_ok=True)
    narration.write_text(json.dumps(build_narration_plan(scenes,
        script_sha256=hashlib.sha256(script.read_bytes()).hexdigest(),
        visual_sha256=hashlib.sha256(visual.read_bytes()).hexdigest())))
    return {"protocolVersion": "video-factory/worker-v1", "commandId": operation,
            "runId": "test-run", "nodeRunId": "voice", "attempt": 1,
            "capability": "voice.synthesize", "outputDir": str(root / "voice" / operation),
            "input": {"scriptPath": str(script), "executablePlanPath": str(visual),
                      "narrationPlanPath": str(narration), "voice": "female-chengshu", "rate": 190,
                      "pause_scale": 1, "mastering_preset": "natural"},
            "parameters": {"provider": "minimax", "providerId": "minimax-tts-v1",
                           "modelId": "speech-2.8-turbo", "estimatedCostCny": 0.5, "maxCostCny": 0.5}}


class ContinuousVoiceWorkerTest(unittest.TestCase):
    def test_completed_audio_with_missing_cost_evidence_is_not_reported_as_success(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = voice_request(root)
            def synthesize(http_request, audio, metadata_path=None, response_binding=None):
                tone(audio, 0.5)
                metadata_path.write_text(json.dumps({"request": response_binding,
                    "audio_sha256": hashlib.sha256(audio.read_bytes()).hexdigest(), "audio_size_bytes": audio.stat().st_size}))
            actual_synthesis = worker_module.synthesize_continuous_voice
            def lose_ledger(*args):
                result = actual_synthesis(*args)
                ledger = root / "voice" / ".voice-operations" / (hashlib.sha256(request["commandId"].encode()).hexdigest() + ".json")
                ledger.unlink()
                return result
            with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=synthesize) as provider, \
                    patch("video_factory.worker.synthesize_continuous_voice", side_effect=lose_ledger), \
                    patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}):
                response = handle_request(request)
                self.assertEqual(provider.call_count, 1)
                self.assertEqual(response["status"], "failed", response)
                self.assertFalse(response["diagnostics"]["providerOutcomeKnown"])
                self.assertNotIn("actualCostCny", response["diagnostics"])
                self.assertEqual({item["kind"] for item in response["artifacts"]},
                                 {"voiceover", "voiceover_plan", "voice_source_manifest"})
                self.assertTrue(all(Path(item["uri"]).is_file() for item in response["artifacts"]))

    def test_stale_source_or_unpriced_voice_is_rejected_before_any_paid_request(self):
        for changed in ("script", "visual", "voice", "budget"):
            with self.subTest(changed=changed), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                request = voice_request(root)
                if changed in ("script", "visual"):
                    target = root / f"{changed}.json"
                    target.write_text(target.read_text() + "\n")
                elif changed == "voice":
                    request["input"]["voice"] = "custom-cloned-voice"
                else:
                    request["parameters"]["maxCostCny"] = 0
                with patch("video_factory.group_voiceover._execute_minimax_audio_request") as provider:
                    response = handle_request(request)
                self.assertEqual(response["status"], "failed")
                provider.assert_not_called()

    def test_group_overflow_reports_group_scope_and_reuses_paid_audio_when_observed_again(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = voice_request(root)
            def synthesize(http_request, audio, metadata_path=None, response_binding=None):
                tone(audio, 20.2)
                metadata_path.write_text(json.dumps({"request": response_binding,
                    "audio_sha256": hashlib.sha256(audio.read_bytes()).hexdigest(),
                    "audio_size_bytes": audio.stat().st_size}))
            with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=synthesize) as provider, \
                    patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}):
                response = handle_request(request)
                self.assertEqual(response["status"], "rejected", response)
                conflict = response["output"]["conflict"]
                self.assertEqual(conflict["groupId"], "narration-1")
                self.assertEqual(conflict["sourceScenePositions"], [1, 2, 3])
                self.assertEqual(conflict["requiredFrames"], 606)
                self.assertNotIn("scenePosition", conflict)
                self.assertTrue(Path(conflict["audioArtifact"]["uri"]).is_file())
                first_hash = conflict["audioArtifact"]["sha256"]
                second = handle_request({**request, "attempt": 2, "outputDir": str(root / "voice" / "recovery")})
                self.assertEqual(second["status"], "rejected", second)
                self.assertEqual(second["output"]["conflict"]["audioArtifact"]["sha256"], first_hash)
                self.assertTrue(Path(second["artifacts"][0]["uri"]).is_relative_to((root / "voice" / "recovery").resolve()))
                self.assertEqual(provider.call_count, 1)

    def test_worker_consumes_confirmed_plan_once_and_retains_visual_index_without_fake_scene_audio(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = voice_request(root)
            def synthesize(http_request, audio, metadata_path=None, response_binding=None):
                tone(audio, 17)
                metadata_path.write_text(json.dumps({"request": response_binding,
                    "audio_sha256": hashlib.sha256(audio.read_bytes()).hexdigest(),
                    "audio_size_bytes": audio.stat().st_size, "extra_info": {"usage_characters": 20}}))
                return audio
            with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=synthesize) as provider, \
                    patch("video_factory.voiceover._execute_minimax_audio_request", side_effect=AssertionError("must not use per-scene TTS")), \
                    patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}):
                response = handle_request(request)
                self.assertEqual(response["status"], "succeeded", response)
                self.assertEqual(provider.call_count, 1)
                restored = handle_request({**request, "attempt": 2, "outputDir": str(root / "voice" / "recovery")})
                self.assertEqual(restored["status"], "succeeded", restored)
                self.assertEqual(provider.call_count, 1)
            plan = json.loads(Path(response["output"]["voiceoverPlanPath"]).read_text())
            self.assertEqual(plan["version"], "video-factory/voiceover-plan-v3")
            self.assertEqual([scene["duration"] for scene in plan["scenes"]], [6, 6, 8])
            self.assertTrue(all("speech_duration" not in scene and "audio_path" not in scene for scene in plan["scenes"]))
            self.assertEqual(plan["subtitles"]["status"], "unavailable")
            self.assertEqual(response["diagnostics"]["meteredAttemptCount"], 1)
            self.assertEqual(response["diagnostics"]["actualCostCny"], 0.01)

    def test_verified_subtitle_evidence_becomes_a_contract_with_sidecars_and_recovery_never_rebuys_audio(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = voice_request(root)
            group_audio_seconds = 17

            def synthesize(http_request, audio, metadata_path=None, response_binding=None):
                tone(audio, group_audio_seconds)
                metadata_path.write_text(json.dumps({
                    "request": response_binding,
                    "audio_sha256": hashlib.sha256(audio.read_bytes()).hexdigest(),
                    "audio_size_bytes": audio.stat().st_size,
                    "subtitle_file": "https://public.example/subtitles/group-1.json",
                }))
                return audio

            # 服务商返回的原始字幕 JSON 只能是已核实 adapter 的形状；这里以内部规范
            # 夹具代表"已核实文档"，绝不把未知字段猜成时间轴。
            sample_cues = json.dumps({"version": "video-factory/internal-sample-cues-v1", "cues": [
                {"start": 0.5, "end": 2.0, "text": "相邻镜头连成一句。"},
                {"start": 2.0, "end": 3.0, "text": "说完收束。"},
            ]}).encode()

            with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=synthesize) as provider, \
                    patch("video_factory.narration_subtitles.open_asset_request", return_value=io.BytesIO(sample_cues)) as subtitle_download, \
                    patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}):
                request["input"]["subtitle_adapter"] = "video-factory/internal-sample-cues-v1"
                response = handle_request(request)
                self.assertEqual(response["status"], "succeeded", response)
                plan = json.loads(Path(response["output"]["voiceoverPlanPath"]).read_text())
                subtitles = plan["subtitles"]
                self.assertEqual(subtitles["version"], "video-factory/narration-subtitles-v1")
                self.assertEqual(subtitles["status"], "verified")
                self.assertEqual(subtitles["adapterVersion"], "video-factory/internal-sample-cues-v1")
                self.assertEqual(subtitles["clock"], {"sampleRate": 44100})
                first_group = subtitles["groups"][0]
                self.assertEqual(first_group["status"], "verified")
                self.assertEqual(first_group["cues"][0]["startSample"], first_group["cues"][0]["localStartSample"] + plan["groups"][0]["startSample"])
                self.assertLessEqual(first_group["cues"][-1]["endSample"], plan["groups"][0]["endSample"])
                voice_dir = Path(response["output"]["voiceoverPlanPath"]).parent
                self.assertTrue((voice_dir / "narration.vtt").is_file())
                self.assertTrue((voice_dir / "narration.ass").is_file())
                self.assertEqual(subtitles["sidecar"], {"vtt": "narration.vtt", "ass": "narration.ass"})
                self.assertIn("WEBVTT", (voice_dir / "narration.vtt").read_text(encoding="utf-8"))
                self.assertIn("Dialogue: 0,", (voice_dir / "narration.ass").read_text(encoding="utf-8"))
                # 纯字幕恢复：同一已采用计划上重跑，只重解析字幕，不重购音频、不重下载缓存。
                request["input"]["recover_subtitles"] = True
                request["input"].update({
                    "voiceoverPlanPath": response["output"]["voiceoverPlanPath"],
                    "voiceoverPlanSha256": hashlib.sha256(Path(response["output"]["voiceoverPlanPath"]).read_bytes()).hexdigest(),
                    "trackSha256": hashlib.sha256(Path(plan["track_path"]).read_bytes()).hexdigest(),
                    "layoutKey": plan["layoutKey"],
                    "sourceOperationId": request["commandId"],
                })
                original_bytes = Path(response["output"]["voiceoverPlanPath"]).read_bytes()
                with patch("video_factory.worker.synthesize_minimax_groups", side_effect=AssertionError("纯字幕恢复不得进入合成")) as no_synthesis, \
                        patch("video_factory.worker.assemble_narration_track", side_effect=AssertionError("纯字幕恢复不得重新排轨")) as no_assembly:
                    recovered = handle_request({**request, "commandId": "subtitle-only-1", "attempt": 1,
                        "outputDir": str(root / "voice" / "recovery")})
                no_synthesis.assert_not_called()
                no_assembly.assert_not_called()
                self.assertEqual(recovered["status"], "succeeded", recovered)
                self.assertEqual(provider.call_count, 1, "恢复不得新增 TTS")
                self.assertEqual(subtitle_download.call_count, 1, "已缓存字幕证据直接复用")
                recovered_plan = json.loads(Path(recovered["output"]["voiceoverPlanPath"]).read_text())
                self.assertEqual(recovered_plan["subtitles"]["status"], "verified")
                self.assertEqual(recovered_plan["subtitles"]["cues"], subtitles["cues"])
                self.assertEqual(Path(recovered_plan["track_path"]).read_bytes(), Path(plan["track_path"]).read_bytes())
                self.assertEqual(Path(response["output"]["voiceoverPlanPath"]).read_bytes(), original_bytes)
                self.assertEqual(recovered["diagnostics"]["meteredAttemptCount"], 0)
                self.assertEqual(recovered["diagnostics"]["actualCostCny"], 0)


class V2VoiceSourceManifestTest(unittest.TestCase):
    """§2.3/S3：全部组音频物化后、排轨前耐久登记；首次排轨失败也是完整可恢复来源。"""

    def _v2_request(self, root: Path, operation: str, windows: list[tuple[int, int]]) -> dict:
        scenes = [{"position": position, "duration": duration, "narration": text}
                  for position, duration, text in ((1, 6, "先看见，"), (2, 6, "再停下，"), (3, 8, "然后出发。"))]
        script = root / "script.json"
        visual = root / "visual.json"
        script.write_text(json.dumps({"duration_target": 20, "scenes": scenes}, ensure_ascii=False))
        visual.write_text(json.dumps({"version": "video-factory/executable-plan-v1", "fps": 30,
            "totalFrames": 600, "durationRange": {"minSeconds": 20, "maxSeconds": 20},
            "cuts": [{"scenePosition": index + 1, "startFrame": start, "frameCount": count,
                      "sourceInFrame": 0, "assetKey": f"scene-{index + 1}"}
                     for index, (start, count) in enumerate(((0, 180), (180, 180), (360, 240)))]}))
        script_sha = hashlib.sha256(script.read_bytes()).hexdigest()
        visual_sha = hashlib.sha256(visual.read_bytes()).hexdigest()
        # 先用合法窗口构建真实计划（组身份/文本/范围全部来自 builder），再按需要收窄窗口制造首次冲突。
        plan = build_narration_plan_v2({"scenes": scenes, "scriptSha256": script_sha, "visualSha256": visual_sha,
            "sourceContextId": "sc-v2-manifest-test",
            "segments": [{"baseGroupIndex": 0, "slices": [
                {"start": 0, "end": 5, "window": {"startFrame": 0, "endFrame": 180}, "placement": {"anchor": "start", "offsetFrames": 0}},
                {"start": 5, "end": 10, "window": {"startFrame": 180, "endFrame": 360}, "placement": {"anchor": "start", "offsetFrames": 0}},
                {"start": 10, "end": 15, "window": {"startFrame": 360, "endFrame": 600}, "placement": {"anchor": "start", "offsetFrames": 0}}]}],
            "userSilences": []})
        for group, (start_frame, end_frame) in zip(plan["groups"], windows):
            group["window"] = {"startFrame": start_frame, "endFrame": end_frame}
        narration = root / "voice" / "narration-v2.json"
        narration.parent.mkdir(parents=True, exist_ok=True)
        narration.write_text(json.dumps(plan, ensure_ascii=False))
        return {"protocolVersion": "video-factory/worker-v1", "commandId": operation,
                "runId": "test-run-v2", "nodeRunId": "voice", "attempt": 1,
                "capability": "voice.synthesize", "outputDir": str(root / "voice" / operation),
                "input": {"scriptPath": str(script), "executablePlanPath": str(visual),
                          "narrationPlanPath": str(narration), "voice": "female-chengshu", "rate": 190,
                          "pause_scale": 1, "mastering_preset": "natural",
                          "voiceInputIdentity": {"voiceInputVersionId": "input-version-1",
                              "sourceContextId": "sc-v2-manifest-test", "scriptArtifactId": "artifact-script",
                              "scriptOutputVersionId": "output-script-1",
                              "visualArtifactId": "artifact-visual",
                              "visualOutputVersionId": "output-visual-1",
                              "parentArtifactIds": ["artifact-script", "artifact-visual"],
                              "upstreamVersionIds": ["upstream-1", "upstream-2"]}},
                "parameters": {"provider": "minimax", "providerId": "minimax-tts-v1",
                               "modelId": "speech-2.8-turbo", "estimatedCostCny": 0.5, "maxCostCny": 0.5}}

    def test_first_fit_conflict_keeps_every_paid_group_with_manifest_and_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            # 三段窗口：第一段放得下，第二段 10 帧 < 15 帧音频 → 首次冲突；三组都已付费物化。
            request = self._v2_request(root, "v2-conflict", [(0, 180), (180, 190), (360, 600)])
            def synthesize(http_request, audio, metadata_path=None, response_binding=None):
                tone(audio, 0.5)
                metadata_path.write_text(json.dumps({"request": response_binding,
                    "audio_sha256": hashlib.sha256(audio.read_bytes()).hexdigest(),
                    "audio_size_bytes": audio.stat().st_size}))
            with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=synthesize) as provider, \
                    patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}):
                response = handle_request(request)
            self.assertEqual(provider.call_count, 3, "冲突前全部组的音频都已真实物化")
            self.assertEqual(response["status"], "rejected")
            conflict = response["output"]["conflict"]
            self.assertEqual(conflict["code"], "NARRATION_GROUP_DOES_NOT_FIT_V2")
            self.assertNotIn("cuts", conflict, "v2 不把收窄窗口伪装成完整 cuts")
            self.assertEqual(conflict["sourceRange"]["baseGroupId"].startswith("nb-"), True)
            self.assertEqual(conflict["availableFrames"], 10)
            self.assertGreaterEqual(conflict["shortfallFrames"], 5)
            receipt = response["output"]["voiceSourceReceipt"]
            self.assertEqual(receipt["version"], "video-factory/voice-source-receipt-v1")
            self.assertEqual(receipt["reason"], "first_fit_conflict")
            self.assertEqual(receipt["sourceContextId"], "sc-v2-manifest-test")
            kinds = {item["kind"] for item in response["artifacts"]}
            self.assertIn("voice_source_manifest", kinds)
            manifest_path = next(item["uri"] for item in response["artifacts"] if item["kind"] == "voice_source_manifest")
            manifest = read_materialized_manifest(Path(manifest_path), root / "voice")
            self.assertEqual(manifest["allAudioMaterialized"], True)
            self.assertEqual(len(manifest["groups"]), 3, "清单登记全部已物化组，而不是只保留冲突组")
            self.assertEqual(manifest["voiceInputVersionId"], "input-version-1")
            self.assertEqual(manifest["script"]["outputVersionId"], "output-script-1")
            self.assertEqual(manifest["visualPlan"]["outputVersionId"], "output-visual-1")
            for entry in manifest["groups"]:
                self.assertTrue((root / "voice" / entry["raw"]["relativePath"]).is_file())
                self.assertGreater(entry["decoded"]["sampleCount"], 0)
            ledger_path = root / "voice" / ".voice-operations" / (
                hashlib.sha256(request["commandId"].encode()).hexdigest() + ".json")
            self.assertEqual(manifest["ledger"]["snapshot"]["sha256"],
                             hashlib.sha256(ledger_path.read_bytes()).hexdigest(),
                             "账本快照与原账本逐字节一致，原账本本身不被改写")

    def test_manifest_qualification_rejects_missing_original_metadata(self):
        """原请求的 metadata 是声音来源证据；缺失时不能生成可排轨资格。"""
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = self._v2_request(root, "v2-missing-metadata", [(0, 180), (180, 360), (360, 600)])

            def synthesize_without_metadata(http_request, audio, metadata_path=None, response_binding=None):
                tone(audio, 0.5)

            with patch("video_factory.group_voiceover._execute_minimax_audio_request",
                       side_effect=synthesize_without_metadata), \
                    patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}):
                response = handle_request(request)

            self.assertEqual(response["status"], "failed", response)
            self.assertFalse((root / "voice" / "v2-missing-metadata" /
                              "materialized_voice_source.json").exists(),
                             "metadata 缺失不得留下 manifest 资格")

    def test_manifest_rebuilds_identically_from_ledger_after_a_write_crash(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = self._v2_request(root, "v2-crash", [(0, 180), (180, 360), (360, 600)])
            def synthesize(http_request, audio, metadata_path=None, response_binding=None):
                tone(audio, 0.5)
                metadata_path.write_text(json.dumps({"request": response_binding,
                    "audio_sha256": hashlib.sha256(audio.read_bytes()).hexdigest(),
                    "audio_size_bytes": audio.stat().st_size}))
            with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=synthesize), \
                    patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}):
                response = handle_request(request)
            self.assertEqual(response["status"], "succeeded", response)
            manifest_path = root / "voice" / "v2-crash" / "materialized_voice_source.json"
            original = json.loads(manifest_path.read_text(encoding="utf-8"))
            # 写后崩溃：清单丢失后按原命令/账本证明全组完成并重放生成，内容一致。
            manifest_path.unlink()
            narration = json.loads(Path(request["input"]["narrationPlanPath"]).read_text(encoding="utf-8"))
            ledger_path = root / "voice" / ".voice-operations" / (
                hashlib.sha256(request["commandId"].encode()).hexdigest() + ".json")
            identity = request["input"]["voiceInputIdentity"]
            rebuilt = build_materialized_manifest(
                run_id=request["runId"], node_id="voice", source_operation_id=request["commandId"],
                voice_input_version_id=identity["voiceInputVersionId"],
                source_context_id=narration["source"]["sourceContextId"],
                narration_plan=narration, narration_plan_path=Path(request["input"]["narrationPlanPath"]),
                narration_plan_sha256=hashlib.sha256(
                    Path(request["input"]["narrationPlanPath"]).read_bytes()).hexdigest(),
                script_artifact_id=identity["scriptArtifactId"],
                script_output_version_id=identity["scriptOutputVersionId"],
                script_sha256=hashlib.sha256(Path(request["input"]["scriptPath"]).read_bytes()).hexdigest(),
                visual_artifact_id=identity["visualArtifactId"],
                visual_output_version_id=identity["visualOutputVersionId"],
                visual_sha256=hashlib.sha256(Path(request["input"]["executablePlanPath"]).read_bytes()).hexdigest(),
                parent_artifact_ids=identity["parentArtifactIds"],
                upstream_version_ids=identity["upstreamVersionIds"],
                synthesis={"provider": "minimax", "providerId": "minimax-tts-v1", "model": "speech-2.8-turbo",
                           "voice": "female-chengshu", "rate": 190, "pauseScale": 1.0, "masteringPreset": "natural",
                           "adapterVersion": "minimax-subtitles-v1"},
                ledger=json.loads(ledger_path.read_text(encoding="utf-8")), ledger_path=ledger_path,
                node_root=root / "voice", output_dir=root / "voice" / "v2-crash")
            self.assertEqual(rebuilt["manifestSha256"], original["manifestSha256"],
                             "写前/写后崩溃的恢复以同一账本与命令重放出同一份清单")

    def test_first_fit_receipt_carries_real_plan_file_facts(self):
        """§4.2.4：收据的计划引用必须是受核原计划自身 version 与计划文件字节 SHA。

        红例来自交付复审 python-probes 的观察：旧实现把 manifest 当计划传入，
        version 误取清单版本、SHA 落空；本测试将其固化为正式断言。
        """
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = self._v2_request(root, "v2-receipt-facts", [(0, 180), (180, 190), (360, 600)])
            def synthesize(http_request, audio, metadata_path=None, response_binding=None):
                tone(audio, 0.5)
                metadata_path.write_text(json.dumps({"request": response_binding,
                    "audio_sha256": hashlib.sha256(audio.read_bytes()).hexdigest(),
                    "audio_size_bytes": audio.stat().st_size}))
            with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=synthesize), \
                    patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}):
                response = handle_request(request)
            self.assertEqual(response["status"], "rejected")
            receipt = response["output"]["voiceSourceReceipt"]
            plan_bytes = Path(request["input"]["narrationPlanPath"]).read_bytes()
            self.assertEqual(receipt["narrationPlan"]["version"], "video-factory/narration-plan-v2")
            self.assertEqual(receipt["narrationPlan"]["sha256"], hashlib.sha256(plan_bytes).hexdigest(),
                             "收据计划 SHA 是原计划文件字节 SHA，不是 canonicalSourceSha256 或空值")
            self.assertIsNone(receipt["manifestArtifactId"],
                              "worker 侧不伪造 artifactId；由宿主正式登记后回填")

    def test_zero_group_plan_produces_silent_track_without_tts(self):
        """§4.2.4 合法无旁白 0 组：不请求 TTS、全片静音轨、字幕表示“不需要”而非失败。

        红例来自交付复审 python-probes 的观察：旧实现要求非空账本，0 组以
        WORKER_REQUEST_FAILED 失败；本测试将其固化为正式断言。
        """
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            scenes = [{"position": position, "duration": duration, "narration": text}
                      for position, duration, text in ((1, 7, "……"), (2, 7, "　"), (3, 6, "…"))]
            script = root / "script.json"
            visual = root / "visual.json"
            script.write_text(json.dumps({"duration_target": 20, "scenes": scenes}, ensure_ascii=False))
            visual.write_text(json.dumps({"version": "video-factory/executable-plan-v1", "fps": 30,
                "totalFrames": 600, "durationRange": {"minSeconds": 20, "maxSeconds": 20},
                "cuts": [{"scenePosition": 1, "startFrame": 0, "frameCount": 210, "sourceInFrame": 0, "assetKey": "scene-1"},
                          {"scenePosition": 2, "startFrame": 210, "frameCount": 210, "sourceInFrame": 0, "assetKey": "scene-2"},
                          {"scenePosition": 3, "startFrame": 420, "frameCount": 180, "sourceInFrame": 0, "assetKey": "scene-3"}]}))
            plan = build_narration_plan_v2({"scenes": scenes,
                "scriptSha256": hashlib.sha256(script.read_bytes()).hexdigest(),
                "visualSha256": hashlib.sha256(visual.read_bytes()).hexdigest(),
                "sourceContextId": "sc-zero-group", "segments": [], "userSilences": []})
            self.assertEqual(plan["groups"], [], "全部镜头无词时 v2 计划合法地为 0 组")
            narration = root / "voice" / "narration-zero.json"
            narration.parent.mkdir(parents=True, exist_ok=True)
            narration.write_text(json.dumps(plan, ensure_ascii=False))
            request = {"protocolVersion": "video-factory/worker-v1", "commandId": "zero-group-op",
                       "runId": "test-run-zero", "nodeRunId": "voice", "attempt": 1,
                       "capability": "voice.synthesize", "outputDir": str(root / "voice" / "zero-group-op"),
                       "input": {"scriptPath": str(script), "executablePlanPath": str(visual),
                                 "narrationPlanPath": str(narration), "voice": "female-chengshu", "rate": 190,
                                 "pause_scale": 1, "mastering_preset": "natural"},
                       "parameters": {"provider": "minimax", "providerId": "minimax-tts-v1",
                                      "modelId": "speech-2.8-turbo", "estimatedCostCny": 0.5, "maxCostCny": 0.5}}
            def fail_synth(*args, **kwargs):
                raise AssertionError("0 组计划不得进入付费合成")
            with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=fail_synth), \
                    patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}):
                response = handle_request(request)
            self.assertEqual(response["status"], "succeeded", response.get("error"))
            # 零合成的证据是 fail_synth 守卫补丁本身（一旦进入付费合成即断言失败）。
            self.assertEqual(response["diagnostics"].get("externalSendCount", 0), 0)
            plan_out = json.loads(Path(response["output"]["voiceoverPlanPath"]).read_text(encoding="utf-8"))
            self.assertEqual(plan_out["version"], "video-factory/voiceover-plan-v3")
            track = Path(response["output"]["trackPath"])
            self.assertTrue(track.is_file())
            import wave
            with wave.open(str(track.with_suffix(".wav")) if track.with_suffix(".wav").is_file() else str(track)) as decoded:
                self.assertEqual(decoded.getnframes(), 600 * 1470, "全片静音轨覆盖 totalFrames")
                frames = decoded.readframes(decoded.getnframes())
            self.assertEqual(frames, b"\x00" * (600 * 1470 * 2), "0 组轨为全零 PCM")
            self.assertEqual(plan_out["subtitles"]["status"], "not_required", "0 组字幕表示不需要，不是失败")
            manifest_path = root / "voice" / "zero-group-op" / "materialized_voice_source.json"
            self.assertTrue(manifest_path.is_file(), "0 组也登记明确身份的来源清单")
            manifest = read_materialized_manifest(manifest_path, root / "voice")
            self.assertEqual(manifest["groups"], [])
            self.assertEqual(manifest["narrationPlan"]["version"], "video-factory/narration-plan-v2")

    def test_manifest_recovery_branch_is_pure_local_after_crash(self):
        """§4.2.4 纯本地归档恢复：manifest 写前/写后中断都不进入合成函数。

        用“合成函数一旦被调用即断言失败”的守卫证明恢复分支零合成；
        写后崩溃核验既有清单，写前崩溃按已结账本重建。
        """
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = self._v2_request(root, "v2-recovery", [(0, 180), (180, 360), (360, 600)])
            def synthesize(http_request, audio, metadata_path=None, response_binding=None):
                tone(audio, 0.5)
                metadata_path.write_text(json.dumps({"request": response_binding,
                    "audio_sha256": hashlib.sha256(audio.read_bytes()).hexdigest(),
                    "audio_size_bytes": audio.stat().st_size}))
            with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=synthesize), \
                    patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}):
                response = handle_request(request)
            self.assertEqual(response["status"], "succeeded")
            original_manifest = root / "voice" / "v2-recovery" / "materialized_voice_source.json"
            self.assertTrue(original_manifest.is_file())

            def fail_synth(*args, **kwargs):
                raise AssertionError("纯本地恢复不得进入合成函数（包括缓存复用路径）")

            # 写后崩溃：清单仍在 → 核验既有清单（verified），不与重建比对、不合成。
            recovery_dir = root / "voice" / "recovery-after"
            recovery_after = {**request, "commandId": "recovery-after",
                              "outputDir": str(recovery_dir),
                              "input": {**request["input"], "rebuild_manifest": True,
                                        "sourceOperationId": "v2-recovery",
                                        "manifestPath": str(original_manifest)}}
            with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=fail_synth), \
                    patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}):
                after = handle_request(recovery_after)
            self.assertEqual(after["status"], "succeeded", after.get("error"))
            self.assertEqual(after["output"]["recovered"], "verified")
            self.assertEqual(after["output"]["manifestSha256"],
                             json.loads(original_manifest.read_text(encoding="utf-8"))["manifestSha256"])

            # 写前崩溃：清单丢失 → 按已结账本重建（rebuilt），原 raw/账本不动、零合成。
            original_manifest.unlink()
            recovery_dir_before = root / "voice" / "recovery-before"
            recovery_before = {**request, "commandId": "recovery-before",
                               "outputDir": str(recovery_dir_before),
                               "input": {**request["input"], "rebuild_manifest": True,
                                         "sourceOperationId": "v2-recovery"}}
            with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=fail_synth), \
                    patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}):
                before = handle_request(recovery_before)
            self.assertEqual(before["status"], "succeeded", before.get("error"))
            self.assertEqual(before["output"]["recovered"], "rebuilt")
            self.assertEqual(before["diagnostics"]["externalSendCount"], 0)
            rebuilt = read_materialized_manifest(Path(before["output"]["manifestPath"]), root / "voice")
            self.assertEqual(len(rebuilt["groups"]), 3, "重建清单仍登记全部组")
            self.assertEqual(rebuilt["narrationPlan"]["sha256"],
                             hashlib.sha256(Path(request["input"]["narrationPlanPath"]).read_bytes()).hexdigest())

            # 不能证明原请求完整结束（账本缺失）时拒绝，不留伪资格。
            missing = {**request, "commandId": "recovery-missing",
                       "outputDir": str(root / "voice" / "recovery-missing"),
                       "input": {**request["input"], "rebuild_manifest": True,
                                 "sourceOperationId": "never-existed"}}
            with self.assertRaises(Exception):
                handle_request(missing)

    def test_manifest_rebuild_rejects_metadata_lost_after_materialization(self):
        """账本已结后丢失原 metadata 也不能靠当前 raw 重算出新的来源资格。"""
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = self._v2_request(root, "v2-meta-lost", [(0, 180), (180, 360), (360, 600)])

            def synthesize(http_request, audio, metadata_path=None, response_binding=None):
                tone(audio, 0.5)
                metadata_path.write_text(json.dumps({"request": response_binding,
                    "audio_sha256": hashlib.sha256(audio.read_bytes()).hexdigest(),
                    "audio_size_bytes": audio.stat().st_size}))

            with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=synthesize), \
                    patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}):
                first = handle_request(request)
            self.assertEqual(first["status"], "succeeded", first)
            (root / "voice" / "v2-meta-lost" / "materialized_voice_source.json").unlink()
            ledger_path = root / "voice" / ".voice-operations" / (
                hashlib.sha256(request["commandId"].encode()).hexdigest() + ".json")
            ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
            Path(ledger["items"][0]["metadataPath"]).unlink()

            recovery = {**request, "commandId": "v2-meta-lost-recovery",
                        "outputDir": str(root / "voice" / "v2-meta-lost-recovery"),
                        "input": {**request["input"], "rebuild_manifest": True,
                                  "sourceOperationId": request["commandId"]}}
            with patch("video_factory.group_voiceover._execute_minimax_audio_request",
                       side_effect=AssertionError("来源归档恢复不得重新合成")), \
                    patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}), \
                    self.assertRaisesRegex(ValueError, "metadata"):
                handle_request(recovery)
            self.assertFalse(Path(recovery["outputDir"], "materialized_voice_source.json").exists())

    def test_verify_materialized_manifest_rejects_incomplete_or_tampered_sources(self):
        """§4.2.4 来源闭环核验：漏组/重复组/计划 SHA 错/同字节新上游版本/unknown 账本全部拒绝。"""
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = self._v2_request(root, "v2-verify", [(0, 180), (180, 360), (360, 600)])
            def synthesize(http_request, audio, metadata_path=None, response_binding=None):
                tone(audio, 0.5)
                metadata_path.write_text(json.dumps({"request": response_binding,
                    "audio_sha256": hashlib.sha256(audio.read_bytes()).hexdigest(),
                    "audio_size_bytes": audio.stat().st_size}))
            with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=synthesize), \
                    patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}):
                response = handle_request(request)
            self.assertEqual(response["status"], "succeeded")
            manifest_path = root / "voice" / "v2-verify" / "materialized_voice_source.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            identity = request["input"]["voiceInputIdentity"]
            plan_path = Path(request["input"]["narrationPlanPath"])
            narration = json.loads(plan_path.read_text(encoding="utf-8"))
            script_sha = hashlib.sha256(Path(request["input"]["scriptPath"]).read_bytes()).hexdigest()
            visual_sha = hashlib.sha256(Path(request["input"]["executablePlanPath"]).read_bytes()).hexdigest()
            common = {"run_id": "test-run-v2", "node_id": "voice", "source_operation_id": "v2-verify",
                      "voice_input_version_id": identity["voiceInputVersionId"],
                      "source_context_id": "sc-v2-manifest-test",
                      "script_artifact_id": "artifact-script", "script_output_version_id": "output-script-1",
                      "script_sha256": script_sha,
                      "visual_artifact_id": "artifact-visual", "visual_output_version_id": "output-visual-1",
                      "visual_sha256": visual_sha,
                      "upstream_version_ids": identity["upstreamVersionIds"],
                      "narration_plan": narration, "narration_plan_path": plan_path}
            from video_factory.materialized_voice_source import verify_materialized_manifest
            verify_materialized_manifest(manifest, root / "voice", **common)  # 原样通过。

            def recompute(manifest_value):
                body = {key: value for key, value in manifest_value.items() if key != "manifestSha256"}
                manifest_value["manifestSha256"] = hashlib.sha256(json.dumps(
                    body, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

            with self.subTest(case="漏组"):
                broken = json.loads(json.dumps(manifest)); broken["groups"].pop(1); recompute(broken)
                with self.assertRaises(ValueError):
                    verify_materialized_manifest(broken, root / "voice", **common)
            with self.subTest(case="重复组"):
                broken = json.loads(json.dumps(manifest)); broken["groups"].append(broken["groups"][0]); recompute(broken)
                with self.assertRaises(ValueError):
                    verify_materialized_manifest(broken, root / "voice", **common)
            with self.subTest(case="计划文件SHA错"):
                broken = json.loads(json.dumps(manifest)); broken["narrationPlan"]["sha256"] = "0" * 64; recompute(broken)
                with self.assertRaises(ValueError):
                    verify_materialized_manifest(broken, root / "voice", **common)
            with self.subTest(case="同字节新上游版本"):
                broken = json.loads(json.dumps(manifest)); broken["script"]["artifactId"] = "artifact-script-new"; recompute(broken)
                with self.assertRaises(ValueError):
                    verify_materialized_manifest(broken, root / "voice", **common)
            with self.subTest(case="输入版本不一致"):
                others = {**common, "voice_input_version_id": "input-version-2"}
                with self.assertRaises(ValueError):
                    verify_materialized_manifest(manifest, root / "voice", **others)
            with self.subTest(case="账本快照unknown"):
                snapshot_rel = manifest["ledger"]["snapshot"]["relativePath"]
                snapshot_path = root / "voice" / snapshot_rel
                snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
                snapshot["items"][0]["state"] = "unknown"
                snapshot_path.write_text(json.dumps(snapshot, ensure_ascii=False))
                with self.assertRaises(ValueError):
                    verify_materialized_manifest(manifest, root / "voice", **common)
