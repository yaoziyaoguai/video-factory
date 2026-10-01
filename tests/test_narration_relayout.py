"""S4 纯本地排轨：复用完整原音频调整时间；零重购、原文件只读、字幕如实重映射。"""

import array
import hashlib
import io
import json
import math
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from test_continuous_voiceover import SAMPLE_RATE, tone
from test_continuous_voice_worker import V2VoiceSourceManifestTest

from video_factory.narration_relayout import parse_relayout_layout
from video_factory.narration_subtitles import map_cues_to_narration_timeline
from video_factory.worker import handle_request, perform_relayout as worker_perform_relayout


def _pcm_samples(path: Path) -> array.array:
    import wave
    with wave.open(str(path), "rb") as audio:
        return array.array("h", audio.readframes(audio.getnframes()))


class NarrationRelayoutTest(V2VoiceSourceManifestTest):
    """继承 manifest 夹具构造能力；relayout 不继承其用例（unittest 只收集本类内 test_*）。"""

    def _synthesize_first_time(self, root: Path, operation: str) -> dict:
        request = self._v2_request(root, operation, [(0, 180), (180, 360), (360, 600)])
        def synthesize(http_request, audio, metadata_path=None, response_binding=None):
            tone(audio, 0.5)
            metadata_path.write_text(json.dumps({"request": response_binding,
                "audio_sha256": hashlib.sha256(audio.read_bytes()).hexdigest(),
                "audio_size_bytes": audio.stat().st_size}))
        with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=synthesize) as provider, \
                patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}):
            response = handle_request(request)
        self.assertEqual(response["status"], "succeeded", response)
        self.assertEqual(provider.call_count, 3)
        return request

    @staticmethod
    def _source_identity(request: dict) -> dict:
        return {**request["input"]["voiceInputIdentity"],
                "narrationPlanPath": request["input"]["narrationPlanPath"]}

    @staticmethod
    def _reservation(command_id: str, attempt: int) -> dict:
        return {
            "requestDigest": "d" * 64,
            "commandId": command_id,
            "layoutOperationId": f"relayout-{command_id}",
            "reservedInputVersionId": f"input-{command_id}",
            "reservedOutputVersionId": f"version-{command_id}",
            "workerExecutionToken": f"worker-{command_id}",
            "attempt": attempt,
        }

    def test_relayout_rejects_changed_original_plan_bytes_before_assemble(self):
        """原计划只追加空白也已换字节；完整来源校验必须在 assemble 前拒绝。"""
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = self._synthesize_first_time(root, "relayout-plan-bytes")
            manifest_path = root / "voice" / "relayout-plan-bytes" / "materialized_voice_source.json"
            plan_path = Path(request["input"]["narrationPlanPath"])
            plan_path.write_bytes(plan_path.read_bytes() + b" ")
            groups = json.loads((root / "voice" / "relayout-plan-bytes" /
                                 "voiceover_plan.json").read_text(encoding="utf-8"))["groups"]
            relayout_request = {"protocolVersion": "video-factory/worker-v1",
                "commandId": "relayout-plan-bytes-attempt", "runId": request["runId"],
                "nodeRunId": "voice", "attempt": 2, "capability": "voice.synthesize",
                "outputDir": str(root / "voice" / "relayout-plan-bytes-attempt"),
                "input": {"relayout": True, "manifestPath": str(manifest_path),
                    "scriptPath": request["input"]["scriptPath"],
                    "executablePlanPath": request["input"]["executablePlanPath"],
                    "sourceOperationId": request["commandId"],
                    "relayoutSource": "materialized_operation",
                    "sourceIdentity": self._source_identity(request),
                    "relayoutReservation": self._reservation("relayout-plan-bytes-attempt", 2),
                    "layout": {"narrationPlanVersion": "video-factory/narration-plan-v2",
                        "groups": [{"groupId": group["id"], "window": dict(group["window"]),
                                    "placement": dict(group["placement"])} for group in groups],
                        "userSilences": []}},
                "parameters": {"provider": "minimax", "maxCostCny": 0}}
            with patch("video_factory.narration_relayout.assemble_narration_track",
                       side_effect=AssertionError("来源校验失败时不得进入 assemble")), \
                    self.assertRaisesRegex(ValueError, "计划|SHA|来源"):
                handle_request(relayout_request)

    def test_relayout_moves_whole_groups_with_zero_external_send_and_remaps_time(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = self._synthesize_first_time(root, "relayout-base")
            manifest_path = root / "voice" / "relayout-base" / "materialized_voice_source.json"
            ledger_path = root / "voice" / ".voice-operations" / (
                hashlib.sha256(request["commandId"].encode()).hexdigest() + ".json")
            ledger_bytes = ledger_path.read_bytes()
            groups = json.loads((root / "voice" / "relayout-base" / "voiceover_plan.json").read_text(encoding="utf-8"))["groups"]
            original_plan_path = root / "voice" / "relayout-base" / "voiceover_plan.json"
            original_plan_bytes = original_plan_path.read_bytes()
            original_manifest_bytes = manifest_path.read_bytes()
            relayout_request = {"protocolVersion": "video-factory/worker-v1", "commandId": "relayout-1",
                "runId": request["runId"], "nodeRunId": "voice", "attempt": 2,
                "capability": "voice.synthesize", "outputDir": str(root / "voice" / "relayout-2"),
                "input": {"relayout": True,
                    "manifestPath": str(manifest_path),
                    "scriptPath": request["input"]["scriptPath"],
                    "executablePlanPath": request["input"]["executablePlanPath"],
                    "sourceOperationId": request["commandId"],
                    "relayoutSource": "materialized_operation",
                    "sourceIdentity": self._source_identity(request),
                    "relayoutReservation": self._reservation("relayout-1", 2),
                    "layout": {"narrationPlanVersion": "video-factory/narration-plan-v2",
                        "groups": [{"groupId": group["id"],
                            "window": {"startFrame": start, "endFrame": end},
                            "placement": {"anchor": "start", "offsetFrames": 0}}
                            for group, (start, end) in zip(groups, ((60, 240), (240, 420), (420, 600)))],
                        "userSilences": []}},
                "parameters": {"provider": "minimax", "maxCostCny": 0}}
            def refuse_every_request(*args, **kwargs):
                raise AssertionError("relayout 不得发起任何外部请求（TTS/字幕/素材）")
            observed_worker_claims = []
            def observe_worker_claim(*args, **kwargs):
                marker = Path(kwargs["output_dir"]) / ".narration-relayout-worker-active.json"
                observed_worker_claims.append(json.loads(marker.read_text(encoding="utf-8")))
                return worker_perform_relayout(*args, **kwargs)
            with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=refuse_every_request), \
                    patch("video_factory.narration_subtitles.open_asset_request", side_effect=refuse_every_request), \
                    patch("video_factory.worker.perform_relayout", side_effect=observe_worker_claim):
                response = handle_request(relayout_request)
            self.assertEqual(response["status"], "succeeded", response)
            self.assertEqual(len(observed_worker_claims), 1)
            self.assertEqual(observed_worker_claims[0]["workerExecutionToken"], "worker-relayout-1")
            self.assertEqual(observed_worker_claims[0]["pid"], __import__("os").getpid())
            self.assertFalse((root / "voice" / "relayout-2" /
                              ".narration-relayout-worker-active.json").exists(),
                             "worker 正常结束后必须释放 attempt 独占标记")
            self.assertEqual(response["diagnostics"]["externalSendCount"], 0)
            self.assertEqual(response["diagnostics"]["actualCostSource"], "local_compute")
            completion_path = Path(response["output"]["completionReceiptPath"])
            target_plan_path = Path(response["output"]["narrationPlanPath"])
            artifact_by_kind = {artifact["kind"]: artifact for artifact in response["artifacts"]}
            self.assertEqual(
                set(artifact_by_kind),
                {"narration_plan", "voiceover_pcm", "voiceover", "voiceover_plan",
                 "narration_relayout_completion"},
                "worker 返回前必须把目标计划、未 mastering PCM、音轨、时间线与完成收据全部纳入产物集合",
            )
            self.assertTrue(completion_path.is_file())
            self.assertTrue(target_plan_path.is_file())
            completion = json.loads(completion_path.read_text(encoding="utf-8"))
            self.assertEqual(completion["version"], "video-factory/narration-relayout-completion-v1")
            self.assertEqual(completion["requestDigest"], "d" * 64)
            self.assertEqual(completion["commandId"], "relayout-1")
            self.assertEqual(completion["layoutOperationId"], "relayout-relayout-1")
            self.assertEqual(completion["runId"], request["runId"])
            self.assertEqual(completion["nodeId"], "voice")
            self.assertEqual(completion["attempt"], 2)
            self.assertEqual(completion["reservedInputVersionId"], "input-relayout-1")
            self.assertEqual(completion["reservedOutputVersionId"], "version-relayout-1")
            self.assertEqual(
                {artifact["kind"] for artifact in completion["artifacts"]},
                {"narration_plan", "voiceover_pcm", "voiceover", "voiceover_plan"},
            )
            for artifact in completion["artifacts"]:
                self.assertFalse(Path(artifact["relativePath"]).is_absolute())
                durable_path = completion_path.parent / artifact["relativePath"]
                self.assertEqual(hashlib.sha256(durable_path.read_bytes()).hexdigest(), artifact["sha256"])
                self.assertEqual(durable_path.stat().st_size, artifact["sizeBytes"])
            plan = json.loads((root / "voice" / "relayout-2" / "voiceover_plan.json").read_text(encoding="utf-8"))
            self.assertEqual(json.loads(target_plan_path.read_text(encoding="utf-8")), plan["narrationPlan"])
            self.assertEqual(plan["subtitles"]["status"], "unavailable",
                             "缺少cue时配音仍可继续，但不能伪造同步字幕")
            self.assertEqual(plan["voiceOperationId"], request["commandId"],
                             "voiceOperationId 仍是原 TTS 操作，不冒充新合成")
            self.assertEqual(plan["relayoutSource"], "materialized_operation")
            self.assertTrue(plan["layoutOperationId"].startswith("relayout-"))
            self.assertTrue(plan["sourceManifestSha256"])
            self.assertNotEqual(plan["targetNarrationPlanSha256"], plan["originNarrationPlanSha256"])
            # 新 PCM：组1 从 60 帧起；[0,60帧) 保持静音，随后是未截断的原音频样本。
            samples = _pcm_samples(Path(plan["pcm_path"]))
            frame_samples = SAMPLE_RATE // 30
            self.assertEqual(len(samples), 600 * frame_samples, "总长仍为 360 帧，不暗改总时长")
            self.assertTrue(all(value == 0 for value in samples[:60 * frame_samples]),
                            "显式留白区间 [0,60) 帧 PCM 全零")
            first_group = next(group for group in plan["groups"] if group["window"]["startFrame"] == 60)
            self.assertEqual(first_group["startSample"], 60 * frame_samples)
            moved = samples[first_group["startSample"]:first_group["endSample"]]
            self.assertTrue(any(value != 0 for value in moved), "移动后的原音频完整出现，未截断")
            # 原 raw、原账本、原清单、原成功版本全部只读。
            self.assertEqual(ledger_path.read_bytes(), ledger_bytes, "原账本不被改写")
            self.assertEqual(manifest_path.read_bytes(), original_manifest_bytes, "原清单不被改写")
            self.assertEqual(original_plan_path.read_bytes(), original_plan_bytes, "旧有效版本字节不变")

    def test_relayout_formally_remaps_verified_cues_and_rejects_bad_binding_without_audio_loss(self):
        """合法cue走正式worker重映射；越过原音频的cue只作unavailable，不损坏或重买声音。"""
        for label, cue_end, expected_status in (("valid", 0.3, "verified"),
                                                 ("wrong-binding", 0.8, "unavailable")):
            with self.subTest(label), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                operation = f"cue-{label}-base"
                request = self._v2_request(root, operation, [(0, 180), (180, 360), (360, 600)])
                request["input"]["subtitle_adapter"] = "video-factory/internal-sample-cues-v1"

                def synthesize(http_request, audio, metadata_path=None, response_binding=None):
                    tone(audio, 0.5)
                    metadata_path.write_text(json.dumps({
                        "request": response_binding,
                        "audio_sha256": hashlib.sha256(audio.read_bytes()).hexdigest(),
                        "audio_size_bytes": audio.stat().st_size,
                        "subtitle_file": "https://public.example/subtitles/group.json",
                    }))
                    return audio

                cue_document = json.dumps({"version": "video-factory/internal-sample-cues-v1", "cues": [
                    {"start": 0.1, "end": cue_end, "text": "受控句级字幕。"},
                ]}).encode()
                with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=synthesize) as provider, \
                        patch("video_factory.narration_subtitles.open_asset_request",
                              side_effect=lambda *args, **kwargs: io.BytesIO(cue_document)) as subtitle_download, \
                        patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}):
                    initial = handle_request(request)
                self.assertEqual(initial["status"], "succeeded", initial)
                self.assertEqual(provider.call_count, 3)
                self.assertEqual(subtitle_download.call_count, 3)

                node_root = root / "voice"
                manifest_path = node_root / operation / "materialized_voice_source.json"
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                original_paths = [manifest_path,
                    node_root / manifest["ledger"]["snapshot"]["relativePath"],
                    *[node_root / group["raw"]["relativePath"] for group in manifest["groups"]]]
                original_bytes = {path: path.read_bytes() for path in original_paths}
                groups = json.loads((node_root / operation / "voiceover_plan.json")
                                    .read_text(encoding="utf-8"))["groups"]
                command_id = f"cue-{label}-relayout"
                relayout_request = {"protocolVersion": "video-factory/worker-v1",
                    "commandId": command_id, "runId": request["runId"], "nodeRunId": "voice",
                    "attempt": 2, "capability": "voice.synthesize",
                    "outputDir": str(node_root / command_id),
                    "input": {"relayout": True, "manifestPath": str(manifest_path),
                        "scriptPath": request["input"]["scriptPath"],
                        "executablePlanPath": request["input"]["executablePlanPath"],
                        "sourceOperationId": request["commandId"],
                        "relayoutSource": "materialized_operation",
                        "sourceIdentity": self._source_identity(request),
                        "relayoutReservation": self._reservation(command_id, 2),
                        "layout": {"narrationPlanVersion": "video-factory/narration-plan-v2",
                            "groups": [{"groupId": group["id"],
                                "window": {"startFrame": start, "endFrame": end},
                                "placement": {"anchor": "start", "offsetFrames": 0}}
                                for group, (start, end) in zip(groups, ((30, 210), (210, 390), (390, 600)))],
                            "userSilences": []}},
                    "parameters": {"provider": "minimax", "maxCostCny": 0}}

                def refuse_every_request(*args, **kwargs):
                    raise AssertionError("relayout不得重新合成或下载cue")

                with patch("video_factory.group_voiceover._execute_minimax_audio_request",
                           side_effect=refuse_every_request) as no_synthesis, \
                        patch("video_factory.narration_subtitles.open_asset_request",
                              side_effect=refuse_every_request) as no_download:
                    relayouted = handle_request(relayout_request)
                no_synthesis.assert_not_called()
                no_download.assert_not_called()
                self.assertEqual(relayouted["status"], "succeeded", relayouted)
                output_plan = json.loads(Path(relayouted["output"]["voiceoverPlanPath"])
                                         .read_text(encoding="utf-8"))
                self.assertEqual(output_plan["subtitles"]["status"], expected_status)
                if expected_status == "verified":
                    first_group = output_plan["groups"][0]
                    first_cue = output_plan["subtitles"]["cues"][0]
                    self.assertEqual(first_cue["startSample"],
                                     first_group["startSample"] + round(0.1 * SAMPLE_RATE),
                                     "合法cue按新组起点重映射")
                    artifact_kinds = {artifact["kind"] for artifact in relayouted["artifacts"]}
                    self.assertIn("narration_vtt", artifact_kinds)
                    self.assertIn("narration_ass", artifact_kinds)
                else:
                    self.assertIn("绑定校验失败", output_plan["subtitles"]["reason"],
                                  "错绑定cue明确降级，不冒充已对齐字幕")
                    self.assertFalse(any(artifact["kind"].startswith("subtitle_")
                                         for artifact in relayouted["artifacts"]))
                for source_path, before in original_bytes.items():
                    self.assertEqual(source_path.read_bytes(), before,
                                     f"{label} cue路径不得改写原声音来源")

    def test_identity_relayout_with_mixed_legacy_and_user_silences_passes(self):
        """§4.2.5：legacy 与 user 静默混合时按规范排序再整体校验，原样重排不再被误拒。

        红例来自交付复审：原 V2-POS-FULL-PLAN-SILENCES 布局原样重排失败，
        根因是 legacy+user 拼接后未排序，与 builder 的规范输出不一致。
        同时核 §4.2.5 的 origin manifest 显式引用与独立 layoutOperationId。
        """
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            scenes = [{"position": position, "duration": duration, "narration": text}
                      for position, duration, text in (
                          (1, 5, "第一镜有词。"), (2, 5, "第二镜接着说。"), (3, 2, "……"),
                          (4, 7, "第四镜继续。"), (5, 3, "第五镜收尾。"))]
            script = root / "script.json"
            visual = root / "visual.json"
            script.write_text(json.dumps({"duration_target": 22, "scenes": scenes}, ensure_ascii=False))
            frame_counts = (150, 150, 60, 210, 90)
            cuts, cursor = [], 0
            for index, count in enumerate(frame_counts):
                cuts.append({"scenePosition": index + 1, "startFrame": cursor, "frameCount": count,
                             "sourceInFrame": 0, "assetKey": f"scene-{index + 1}"})
                cursor += count
            visual.write_text(json.dumps({"version": "video-factory/executable-plan-v1", "fps": 30,
                "totalFrames": cursor, "durationRange": {"minSeconds": 20, "maxSeconds": 30}, "cuts": cuts}))
            from video_factory.narration_plan import build_narration_plan_v2
            plan = build_narration_plan_v2({"scenes": scenes,
                "scriptSha256": hashlib.sha256(script.read_bytes()).hexdigest(),
                "visualSha256": hashlib.sha256(visual.read_bytes()).hexdigest(),
                "sourceContextId": "sc-mixed-silences",
                "segments": [
                    {"baseGroupIndex": 0, "slices": [
                        {"start": 0, "end": 7, "window": {"startFrame": 0, "endFrame": 100},
                         "placement": {"anchor": "start", "offsetFrames": 0}},
                        {"start": 7, "end": 14, "window": {"startFrame": 150, "endFrame": 300},
                         "placement": {"anchor": "start", "offsetFrames": 0}}]},
                    {"baseGroupIndex": 1, "slices": [
                        {"start": 0, "end": 13, "window": {"startFrame": 360, "endFrame": 660},
                         "placement": {"anchor": "start", "offsetFrames": 0}}]}],
                "userSilences": [{"startFrame": 100, "endFrame": 150}]})
            # 规范计划中静默已排序：user[100,150) 在 legacy[300,360) 之前。
            self.assertEqual([s["startFrame"] for s in plan["silences"]], [100, 300])
            narration = root / "voice" / "narration-mixed.json"
            narration.parent.mkdir(parents=True, exist_ok=True)
            narration.write_text(json.dumps(plan, ensure_ascii=False))
            request = {"protocolVersion": "video-factory/worker-v1", "commandId": "mixed-base",
                       "runId": "test-run-mixed", "nodeRunId": "voice", "attempt": 1,
                       "capability": "voice.synthesize", "outputDir": str(root / "voice" / "mixed-base"),
                       "input": {"scriptPath": str(script), "executablePlanPath": str(visual),
                                 "narrationPlanPath": str(narration), "voice": "female-chengshu", "rate": 190,
                                 "pause_scale": 1, "mastering_preset": "natural",
                                 "voiceInputIdentity": {"voiceInputVersionId": "iv-mixed",
                                     "sourceContextId": "sc-mixed-silences", "scriptArtifactId": "a-script",
                                     "scriptOutputVersionId": "v-script",
                                     "visualArtifactId": "a-visual", "parentArtifactIds": ["a-script", "a-visual"],
                                     "visualOutputVersionId": "v-visual",
                                     "upstreamVersionIds": ["u-1"]}},
                       "parameters": {"provider": "minimax", "providerId": "minimax-tts-v1",
                                      "modelId": "speech-2.8-turbo", "estimatedCostCny": 0.5, "maxCostCny": 0.5}}
            def synthesize(http_request, audio, metadata_path=None, response_binding=None):
                tone(audio, 0.5)
                metadata_path.write_text(json.dumps({"request": response_binding,
                    "audio_sha256": hashlib.sha256(audio.read_bytes()).hexdigest(),
                    "audio_size_bytes": audio.stat().st_size}))
            with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=synthesize), \
                    patch.dict("os.environ", {"MINIMAX_API_KEY": "test-key"}):
                first = handle_request(request)
            self.assertEqual(first["status"], "succeeded", first.get("error"))
            manifest_path = root / "voice" / "mixed-base" / "materialized_voice_source.json"

            # 原样重排（同窗口、同用户留白）：混合静默按规范排序后必须通过。
            plan_groups = json.loads((root / "voice" / "mixed-base" / "voiceover_plan.json")
                                     .read_text(encoding="utf-8"))["narrationPlan"]["groups"]
            relayout_request = {"protocolVersion": "video-factory/worker-v1", "commandId": "relayout-mixed-1",
                "runId": request["runId"], "nodeRunId": "voice", "attempt": 2,
                "capability": "voice.synthesize", "outputDir": str(root / "voice" / "relayout-mixed"),
                "input": {"relayout": True, "manifestPath": str(manifest_path),
                    "scriptPath": str(script), "executablePlanPath": str(visual),
                    "sourceOperationId": "mixed-base", "relayoutSource": "materialized_operation",
                    "sourceIdentity": self._source_identity(request),
                    "relayoutReservation": self._reservation("relayout-mixed-1", 2),
                    "layout": {"narrationPlanVersion": "video-factory/narration-plan-v2",
                        "groups": [{"groupId": group["id"], "window": dict(group["window"]),
                                    "placement": dict(group["placement"])} for group in plan_groups],
                        "userSilences": [{"startFrame": 100, "endFrame": 150}]}},
                "parameters": {"provider": "minimax", "maxCostCny": 0}}
            def refuse_every_request(*args, **kwargs):
                raise AssertionError("relayout 不得发起任何外部请求")
            with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=refuse_every_request), \
                    patch("video_factory.narration_subtitles.open_asset_request", side_effect=refuse_every_request):
                response = handle_request(relayout_request)
            self.assertEqual(response["status"], "succeeded", response.get("error"))
            new_plan = json.loads((root / "voice" / "relayout-mixed" / "voiceover_plan.json").read_text(encoding="utf-8"))
            # layoutOperationId 取本次排轨操作身份，不由原 TTS 操作派生。
            self.assertEqual(new_plan["layoutOperationId"], "relayout-relayout-mixed-1")
            self.assertEqual(new_plan["voiceOperationId"], "mixed-base")
            # origin manifest 显式引用：后续调整不再从当前 attempt 同目录猜路径。
            origin = new_plan["originManifest"]
            self.assertEqual(origin["relativePath"],
                             manifest_path.resolve().relative_to((root / "voice").resolve()).as_posix())
            self.assertEqual(origin["manifestSha256"],
                             json.loads(manifest_path.read_text(encoding="utf-8"))["manifestSha256"])
            self.assertEqual(origin["fileSha256"], hashlib.sha256(manifest_path.read_bytes()).hexdigest())
            # 原样重排：目标计划与原计划 canonical 摘要相等（注意 originNarrationPlanSha256 是
            # 原计划文件字节 SHA，与 canonical 摘要是两种语义，不能直接互比）。
            from video_factory.narration_plan import canonical_json_v2
            original_plan_value = json.loads(narration.read_text(encoding="utf-8"))
            self.assertEqual(new_plan["targetNarrationPlanSha256"],
                             hashlib.sha256(canonical_json_v2(original_plan_value).encode("utf-8")).hexdigest(),
                             "原样重排的目标计划与原计划一致")

    def test_relayout_that_still_does_not_fit_returns_conflict_and_touches_nothing(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = self._synthesize_first_time(root, "relayout-fit-base")
            manifest_path = root / "voice" / "relayout-fit-base" / "materialized_voice_source.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            before = manifest_path.read_bytes()
            groups = json.loads((root / "voice" / "relayout-fit-base" / "voiceover_plan.json").read_text(encoding="utf-8"))["groups"]
            relayout_request = {"protocolVersion": "video-factory/worker-v1", "commandId": "relayout-tight",
                "runId": request["runId"], "nodeRunId": "voice", "attempt": 2,
                "capability": "voice.synthesize", "outputDir": str(root / "voice" / "relayout-tight"),
                "input": {"relayout": True, "manifestPath": str(manifest_path),
                    "scriptPath": request["input"]["scriptPath"],
                    "executablePlanPath": request["input"]["executablePlanPath"],
                    "sourceOperationId": request["commandId"],
                    "relayoutSource": "materialized_operation",
                    "sourceIdentity": self._source_identity(request),
                    "sourceManifestIdentity": {"artifactId": "artifact-source-manifest",
                                               "sha256": manifest["manifestSha256"]},
                    "relayoutReservation": self._reservation("relayout-tight", 2),
                    "layout": {"narrationPlanVersion": "video-factory/narration-plan-v2",
                        "groups": [
                            {"groupId": groups[0]["id"], "window": {"startFrame": 0, "endFrame": 10},
                             "placement": {"anchor": "start", "offsetFrames": 0}},
                            {"groupId": groups[1]["id"], "window": {"startFrame": 180, "endFrame": 360},
                             "placement": {"anchor": "start", "offsetFrames": 0}},
                            {"groupId": groups[2]["id"], "window": {"startFrame": 360, "endFrame": 600},
                             "placement": {"anchor": "start", "offsetFrames": 0}}],
                        "userSilences": []}},
                "parameters": {"provider": "minimax", "maxCostCny": 0}}
            def refuse(*args, **kwargs):
                raise AssertionError("relayout 冲突路径同样不得外部发送")
            with patch("video_factory.group_voiceover._execute_minimax_audio_request", side_effect=refuse), \
                    patch("video_factory.narration_subtitles.open_asset_request", side_effect=refuse):
                response = handle_request(relayout_request)
            self.assertEqual(response["status"], "rejected")
            conflict = response["output"]["conflict"]
            self.assertEqual(conflict["version"], "video-factory/narration-fit-conflict-v2")
            self.assertEqual(conflict["code"], "NARRATION_GROUP_DOES_NOT_FIT_V2")
            self.assertEqual(conflict["sourceOperationId"], request["commandId"])
            self.assertEqual(conflict["sourceContextId"], "sc-v2-manifest-test")
            self.assertEqual(conflict["manifestArtifactId"], "artifact-source-manifest")
            self.assertEqual(conflict["manifestSha256"], manifest["manifestSha256"])
            self.assertEqual(conflict["sourceRange"], groups[0]["sourceRange"])
            self.assertEqual(conflict["window"], {"startFrame": 0, "endFrame": 10})
            self.assertEqual(conflict["placement"], {"anchor": "start", "offsetFrames": 0})
            self.assertGreater(conflict["sourceSamples"], 0)
            self.assertEqual(conflict["availableFrames"], 10)
            self.assertEqual(conflict["shortfallFrames"],
                             conflict["requiredFrames"] - conflict["availableFrames"])
            self.assertNotIn("cuts", conflict, "v2 窄窗口不伪造完整 cuts")
            self.assertTrue(all(value is not None for value in conflict.values()))
            self.assertEqual(response["diagnostics"]["externalSendCount"], 0)
            self.assertEqual(manifest_path.read_bytes(), before, "失败调整不损坏任何来源")

    def test_v1_layout_rejects_window_change_and_foreign_groups(self):
        """v1 只改落点：窗口变化/未知分组/引入留白都在布局解析处拒绝。"""
        import copy
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            request = self._v2_request(root, "v1-window", [(0, 180), (180, 360), (360, 600)])
            original = json.loads(Path(request["input"]["narrationPlanPath"]).read_text(encoding="utf-8"))
            # 构造一个 v1 计划（与 build_narration_plan 同构）验证布局禁令。
            from video_factory.narration_plan import build_narration_plan
            scenes = [{"position": p, "duration": d, "narration": t}
                      for p, d, t in ((1, 6, "先看见，"), (2, 6, "再停下，"), (3, 8, "然后出发。"))]
            v1 = build_narration_plan(scenes, script_sha256="a" * 64, visual_sha256="b" * 64)
            group = v1["groups"][0]
            base_layout = {"narrationPlanVersion": "video-factory/narration-plan-v1",
                "groups": [{"groupId": group["id"], "window": dict(group["window"]),
                            "placement": {"anchor": "start", "offsetFrames": 12}}],
                "userSilences": []}
            parsed = parse_relayout_layout(copy.deepcopy(base_layout), v1)
            self.assertEqual(parsed["groups"][0]["placement"]["offsetFrames"], 12)
            for broken, note in (
                ({"groups": [{**base_layout["groups"][0],
                              "window": {"startFrame": 0, "endFrame": 150}}]}, "窗口变化"),
                ({"groups": [{"groupId": "narration-9", "window": dict(group["window"]),
                              "placement": {"anchor": "start", "offsetFrames": 0}}]}, "未知分组"),
                ({"userSilences": [{"startFrame": 10, "endFrame": 20}]}, "引入留白"),
            ):
                with self.subTest(note):
                    mutated = copy.deepcopy(base_layout)
                    mutated.update(broken)
                    with self.assertRaises(ValueError):
                        parse_relayout_layout(mutated, v1)
            with self.assertRaises(ValueError):
                parse_relayout_layout(copy.deepcopy(base_layout) | {"narrationPlanVersion": "video-factory/narration-plan-v2"}, v1)

    def test_sentence_cues_shift_with_the_group_start_sample_without_changing_order(self):
        cues = [{"text": "第一句", "start": 0.5, "end": 1.0},
                {"text": "第二句", "start": 1.5, "end": 2.5}]
        group = {"startSample": 88_200, "sourceAudioSamples": 220_500,
                 "window": {"startFrame": 60, "endFrame": 240}}
        mapped = map_cues_to_narration_timeline(cues, group)
        self.assertEqual([cue["startSample"] for cue in mapped],
                         [88_200 + round(0.5 * SAMPLE_RATE), 88_200 + round(1.5 * SAMPLE_RATE)])
        self.assertEqual([cue["text"] for cue in mapped], ["第一句", "第二句"],
                         "组内 cue 次序与时长保持不变，只整体平移到新 startSample")


if __name__ == "__main__":
    unittest.main()
